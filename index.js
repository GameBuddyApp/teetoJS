'use strict'

const util = require("util");
const req = require("request-promise");
const defaultConfig = require("./config.json");
const limiter = require("rolling-rate-limiter");
const redis = require("redis");

const PRIORITIES = {
	"HIGH": 1,
	"NORMAL": 0
};

/** `RiotApi(key [, config])` or `RiotApi(config)` with `config.key` set. */
function RiotApi(apiKey, redisConfig = null, config = defaultConfig) {
	if (!(this instanceof RiotApi)) return new RiotApi(...arguments);
	this.config = config;
	this.config.key = apiKey;
	this.regions = {};
	if (redisConfig != null) this.config.redis = redisConfig; // TODO: Validate config before usage
	this.redisClient = redis.createClient(this.config.redis);
}

RiotApi.prototype.get = function () {
	if (this.regions[arguments[0]] === undefined)
		this.regions[arguments[0]] = new Region(this.config, this.redisClient);

	return this.regions[arguments[0]].get(...arguments);
};

/** RateLimits for a region. One app limit and any number of method limits. */
function Region(config, redisClient) {
	console.log("New region");
	this.config = config;
	this.appLimiters = [];
	this.methodLimiters = {};
	this.redisClient = redisClient;
	let appLimit_1 = this._getLimits(this.config.applimit[0]);
	this.appLimiters.push(
		limiter({
			redis: this.redisClient,
			namespace: process.env.NODE_ENV + 'app_0', // TODO maybe settable by user
			interval: appLimit_1.interval,
			maxInInterval: appLimit_1.maxRequests,
			minDifference: Math.ceil(appLimit_1.interval / appLimit_1.maxRequests * this.config.edgeCaseBuffer)
		})
	);
	let appLimit_2 = this._getLimits(this.config.applimit[1]);
	let minDiff = this.config.spreadToSlowest ? Math.ceil(appLimit_2.interval / appLimit_2.maxRequests * this.config.edgeCaseBuffer) : 0;
	this.appLimiters.push(
		limiter({
			redis: this.redisClient,
			namespace: process.env.NODE_ENV + 'app_1', // TODO maybe settable by user
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
			console.log("Add to priority");
			queueToPush = this.priorityRequestQueue;
		} else {
			console.log("Add to normal");
			queueToPush = this.requestQueue;
		}

		queueToPush.push({
			arguments: arguments,
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
				console.log("Process priority");
				await that._process(that, that.priorityRequestQueue);
			}
			if(that.requestQueue.length > 0) {
				console.log("Process normal");
				await that._process(that, that.requestQueue);
			}
		}
		if (that.priorityRequestQueue.length <= 0 && that.requestQueue.length <= 0) {
			that.isProcessing = false;
			console.log("Resetting")
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
		console.error("Api endpoint " + target + "not defined");
		return queueItem.onError("Api endpoint " + target + " not defined");
	}
	let url = that._buildUrl(prefix, endpoint.url, queueItem.arguments);

	// Create methodlimiter, if not already created
	that.createMethodLimiter(endpoint.limit, target);

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
		that._getAttemptPromise(that.methodLimiters[target])
			.then(time => methodTimeLeft = time)
	);
	await Promise.all(attemptPromises);
	let timeLeft = appTimeLeft > methodTimeLeft ? appTimeLeft : methodTimeLeft;
	if (timeLeft > 0) {
		console.log("Snoozing for", timeLeft);
		await snooze(timeLeft);
	}

	// send request to riot
	return that._sendRequest(url.url, url.qs, queueItem);
}

Region.prototype._sendRequest = function (url, qs, queueItem) {
	
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
		// TODO: adjust method limits
		return queueItem.callback(res.body);
	})
	.catch(err => {
		// TODO: adjust method limits
		switch (err.statusCode) {
			case 404:
				return queueItem.callback(null);
			case 429:
				console.error(err.response.headers);
				return queueItem.onError(err.message);
			// TODO: limit exceeded backoff
			case 500:
			// TODO: internal server error riot, retry
			case 503:
			// TODO: service unavailable, retry
			default: return queueItem.onError(err.message);
		}
	});
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

Region.prototype.createMethodLimiter = function (limit, target) {
	if (this.methodLimiters[target] === undefined) {
		let methodlimit = this._getLimits(limit);
		this.methodLimiters[target] = limiter({
			redis: this.redisClient,
			namespace: process.env.NODE_ENV + target, // TODO maybe settable by user
			interval: methodlimit.interval,
			maxInInterval: methodlimit.maxRequests
		});
		console.log("New method limiter");
	}
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