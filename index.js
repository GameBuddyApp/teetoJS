'use strict'

const util = require("util");
const req = require("request-promise");
const defaultConfig = require("./config.json");
const limiter = require("./lib/rolling-rate-limiter");
const redis = require("redis");

const PRIORITIES = {
	"HIGH": 1,
	"NORMAL": 0
};

/** `RiotApi(key [, config])` or `RiotApi(config)` with `config.key` set. */
function RiotApi(apiKey, config) {
	if (!(this instanceof RiotApi)) return new RiotApi(...arguments);
	this.config = Object.assign({}, defaultConfig, config);
	this.config.key = apiKey;
	this.regions = {};
	this.redisClient = redis.createClient(this.config.redis);
}

RiotApi.prototype.get = function () {
	if (this.regions[arguments[0]] === undefined)
		this.regions[arguments[0]] = new Region(this.config, this.redisClient, arguments[0]);

	return this.regions[arguments[0]].get(...arguments);
};

/** RateLimits for a region. One app limit and any number of method limits. */
function Region(config, redisClient, platformId) {
	if(config.debug) console.log("New region");
	this.config = config;
	this.platformId = platformId;
	this.appLimiters = [];
	this.methodLimits = {};
	this.redisClient = redisClient;
	let appLimit_1 = this._getLimits(this.config.applimit[0]);
	this.appLimiters.push(
		limiter({
			redis: this.redisClient,
			namespace: process.env.NODE_ENV + 'app_0',
			interval: appLimit_1.interval,
			maxInInterval: appLimit_1.maxRequests,
			minDifference: Math.ceil(appLimit_1.interval / appLimit_1.maxRequests * this.config.edgeCaseFixValue)
		})
	);
	let appLimit_2 = this._getLimits(this.config.applimit[1]);
	let minDiff = this.config.spreadToSlowest ? Math.ceil(appLimit_2.interval / appLimit_2.maxRequests * this.config.edgeCaseFixValue) : 0;
	this.appLimiters.push(
		limiter({
			redis: this.redisClient,
			namespace: process.env.NODE_ENV + 'app_1',
			interval: appLimit_2.interval,
			maxInInterval: appLimit_2.maxRequests,
			minDifference: minDiff
		})
	);
	this.priorityRequestQueue = [];
	this.requestQueue = [];
	this.isProcessing = false;
}

Region.prototype.get = function () {
	return new Promise((resolve, reject) => {

		let priority = arguments[2];

		let queueToPush;
		if (priority === PRIORITIES.HIGH) {
			queueToPush = this.priorityRequestQueue;
		} else {
			queueToPush = this.requestQueue;
		}

		queueToPush.push({
			arguments: arguments,
			retryCount: 0,
			retryMS: 0,
			callback: res => {
				return resolve(res);
			},
			onError: err => {
				return reject(err);
			}
		});

		this.processQueue(this);
	});
}

Region.prototype.processQueue = async(that) => {

	if (!that.isProcessing) {
		that.isProcessing = true;
		while (that.priorityRequestQueue.length > 0 || that.requestQueue.length > 0) {
			while(that.priorityRequestQueue.length > 0) {
				await that._process(that, that.priorityRequestQueue);
			}
			if(that.requestQueue.length > 0) {
				await that._process(that, that.requestQueue);
			}
		}
		if (that.priorityRequestQueue.length <= 0 && that.requestQueue.length <= 0) {
			that.isProcessing = false;
			if(that.config.debug) console.log("Resetting");
		}
	}

}

Region.prototype._process = async(that, queue) => {
	let queueItem = queue.pop();
	
	// Build URL
	let prefix = util.format(that.config.prefix, queueItem.arguments[0]);
	let target = queueItem.arguments[1];
	let endpoint = that._getEndpoint(target);
	if (endpoint === undefined) {
		return queueItem.onError("Api endpoint " + target + " not defined");
	}
	let url = that._buildUrl(prefix, endpoint.url, queueItem.arguments);

	// Create methodlimiter, if not already created
	await that.createMethodLimiter(endpoint.limit, target);

	// Create app limit and method limit attempt promise
	let attemptPromises = [];
	let appTimeLeft = 0;
	that.appLimiters.forEach(limiter => {
		attemptPromises.push(
			that._getAttemptPromise(limiter)
				.then(time => {
					if (time > appTimeLeft) appTimeLeft = time;
				})
		);
	});
	let methodTimeLeft = 0;
	attemptPromises.push(
		that._getAttemptPromise(that.methodLimits[target].limiter)
			.then(time => methodTimeLeft = time)
	);
	await Promise.all(attemptPromises);
	let timeLeft = appTimeLeft > methodTimeLeft ? appTimeLeft : methodTimeLeft;
	if (timeLeft > 0 || queueItem.retryMS > 0) {
		if(that.config.debug) console.log("Snoozing for", timeLeft + queueItem.retryMS);
		await snooze(timeLeft + queueItem.retryMS);
	}

	// send request to riot
	return that._sendRequest(url.url, url.qs, target, queueItem);
}

Region.prototype._sendRequest = function (url, qs, target, queueItem) {
	
	var options = {
		uri: url,
		method: 'GET',
		resolveWithFullResponse: true,
		qs: qs,
		qsStringifyOptions: { indices: false },
		headers: {
			'X-Riot-Token': this.config.key
		},
		json: true
	};

	req(options)
	.then(res => {
		this._adjustMethodLimit(target, res.headers);
		return queueItem.callback(res.body);
	})
	.catch(err => {
		if(err.response) this._adjustMethodLimit(target, err.response.headers);
		switch (err.statusCode) {
			case 404:
				return queueItem.callback(null);
			case 429:
				if(this.config.showWarn) console.error("429 - Rate limit exceeded", {
					headers: err.response.headers,
					url: url
				});
				if(this.config.exceededCallback != null) this.config.exceededCallback({
					headers: err.response.headers,
					url: url
				});
				if(queueItem.retryCount < this.config.maxRetriesAmnt) {
					// if retry-after is given take that as time, else take default value from config
					let retryMS = err.response.headers['retry-after'] != null ? parseInt(err.response.headers['retry-after'])*1000 : null;
					queueItem.arguments[2] = PRIORITIES.HIGH; // set priority to high so we dont cause more 429 errors
					return this._retryRequest(queueItem, retryMS);
				} else {
					return queueItem.onError("429 - Aborting request after retrying " + queueItem.retryCount + " times", {
						statusCode: err.statusCode,
						msg: err.message,
						url: url
					});
				}
			case 500: // fall through to 503				
			case 503: 
				// internal server error or service unavailable at riot, retry
				if(queueItem.retryCount < this.config.maxRetriesAmnt) {
					return this._retryRequest(queueItem);
				} else {
					return queueItem.onError("Aborting request after retrying " + queueItem.retryCount + " times", {
						statusCode: err.statusCode,
						msg: err.message,
						url: url
					});
				}
			default: return queueItem.onError({
				statusCode: err.statusCode,
				msg: err.message
			});
		}
	});
}

Region.prototype._adjustMethodLimit = function(target, headers) {
	let methodLimit = headers['x-method-rate-limit'];
	if(methodLimit != null && methodLimit !== this.methodLimits[target].limit) {
		this.createMethodLimiter(methodLimit, target, true);
		// save in redis
		this.redisClient.set(process.env.NODE_ENV + this.platformId + target + "_limit", methodLimit);
	}
}

Region.prototype._retryRequest = function(item, retryMS = null) {
	item.retryCount++;
	if(retryMS !== null) item.retryMS = retryMS;
	else item.retryMS = item.retryMS == 0 ? this.config.retryMS : item.retryMS * 2;
	let priority = item.arguments[2];
	if(priority === PRIORITIES.HIGH) this.priorityRequestQueue.unshift(item);
	else this.requestQueue.unshift(item);

	// tell queue to run if not running already
	this.processQueue(this);
}

Region.prototype._getEndpoint = function (target) {
	let path = target.split('.')[1];
	let endpoint = this.config.endpoints;
	for (let path of target.split('.'))
		endpoint = endpoint[path];
	return endpoint;
}

Region.prototype._buildUrl = function (prefix, suffix) {
	let qs = {};
	let args = Array.prototype.slice.call(arguments[2], 3);
	if (typeof args[args.length - 1] === 'object') // If last obj is query string, pop it off.
		qs = args.pop();
	if (suffix.split('%s').length - 1 !== args.length)
		throw new Error(util.format('Wrong number of path arguments: "%j", for path "%s".', args, suffix));
	suffix = util.format(suffix, ...args);
	return {
		url: prefix + suffix,
		qs: qs
	};
}

Region.prototype.createMethodLimiter = function (endpointLimit, target, forceNew = false) {
	return new Promise((resolve, reject) => {
		if (this.methodLimits[target] === undefined || forceNew) {
			// get limit from redis, if not available take limit from config
			this.redisClient.get(process.env.NODE_ENV + this.platformId + target + "_limit", (err, res) => {
				let limit = endpointLimit;
				if(!err && res != null) {
					limit = res;
					if(this.config.debug) console.log("Got limit from redis", limit);
				}

				let methodlimit = this._getLimits(limit);
				this.methodLimits[target] = {
					limit: limit,
					limiter: limiter({
						redis: this.redisClient,
						namespace: process.env.NODE_ENV + this.platformId + target,
						interval: methodlimit.interval,
						maxInInterval: methodlimit.maxRequests,
						minDifference: Math.ceil(methodlimit.interval / methodlimit.maxRequests * this.config.edgeCaseFixValue)
					})
				}
				if(this.config.debug) console.log("New method limiter for " + target);
				return resolve();
			});
		} else return resolve();
	});
}

Region.prototype._getLimits = function (limitString) {
	let limitArray = limitString.split(":");
	return {
		maxRequests: parseInt(limitArray[0]),
		interval: parseInt(limitArray[1]) * 1000
	};
}

Region.prototype._getAttemptPromise = function (explicitLimiter) {
	return new Promise((resolve, reject) => {
		explicitLimiter((err, timeLeft, actionsLeft) => {
			if (err) {
				resolve(500); // backing off 500ms if an unknown error occured
			} else if (timeLeft) {
				resolve(timeLeft);
				// limit was exceeded, action should not be allowed
			} else {
				resolve(0);
				// limit was not exceeded, action should be allowed
			}
		});
	});
}
const snooze = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = RiotApi;