'use strict'

const util = require("util");
const req = require("request-promise");
const defaultConfig = require("./config.json");
const limiter = require("rolling-rate-limiter");
const redis = require("redis");


/** `RiotApi(key [, config])` or `RiotApi(config)` with `config.key` set. */
function RiotApi(apiKey, redisConfig = null, config = defaultConfig) {
  if (!(this instanceof RiotApi)) return new RiotApi(...arguments);
  this.config = config;
  this.config.key = apiKey;
  this.regions = {};
  if(redisConfig != null) this.config.redis = redisConfig; // TODO: Validate config before usage
  this.redisClient = redis.createClient(this.config.redis);
}

RiotApi.prototype.get = function() {
	if(this.regions[arguments[0]] === undefined)
		this.regions[arguments[0]] = new Region(this.config, this.redisClient);

	return this.regions[arguments[0]].get(...arguments);
};

/** RateLimits for a region. One app limit and any number of method limits. */
function Region(config, redisClient) {
	this.config = config;
	this.methodLimiters = {};
	this.redisClient = redisClient;
	let appLimit = this._getLimits(this.config.applimit);
	this.appLimiter = limiter({
		redis: this.redisClient,
		namespace: process.env.NODE_ENV + 'app', // TODO maybe settable by user
		interval: appLimit.interval,
		maxInInterval: appLimit.maxRequests
	});
	this.requestQueue = [];
	this.isProcessing = false;
}

Region.prototype.get = function() {

	console.log('starting get promise');

	return new Promise((resolve, reject) => {
		// TODO: Multiple Priorities with two queues
		this.requestQueue.push({
			arguments : arguments,
			callback : res => {
				resolve(res);
			},
			onError : err => {
				reject(err);
			}
		});

		this.processQueue(this);
	});
}

Region.prototype.processQueue = async(that) => {

	while(that.requestQueue.length > 0 && !that.isProcessing){

		that.isProcessing = true;
		let queueItem = that.requestQueue.pop();

		// Build URL
		let prefix = util.format(that.config.prefix, queueItem.arguments[0]);
		let target = queueItem.arguments[1];
		let path = target.split('.')[1];
		let suffix = that.config.endpoints;
		for (let path of target.split('.'))
		    suffix = suffix[path];
		let endpoint = suffix.url;
		// TODO check suffix catch
		let qs = {};
		let args = Array.prototype.slice.call(queueItem.arguments, 2);
		if (typeof args[args.length - 1] === 'object') // If last obj is query string, pop it off.
			qs = args.pop();
		if (endpoint.split('%s').length - 1 !== args.length)
			throw new Error(util.format('Wrong number of path arguments: "%j", for path "%s".', args, endpoint));
		endpoint = util.format(endpoint, ...args);
		let url = prefix + endpoint;

		// Create methodlimiter, if not already created
		if(that.methodLimiters[target] === undefined){
			let methodlimit = that._getLimits(suffix.limit);
			that.methodLimiters[target] = limiter({
			  	redis: that.redisClient,
			  	namespace: process.env.NODE_ENV + target, // TODO maybe settable by user
				interval: methodlimit.interval,
				maxInInterval: methodlimit.maxRequests
			});
		}

		// Create app limit and method limit attempt promise
		let attemptPromises = [];
		let appTimeLeft = 0;
		attemptPromises.push(
			that._getAttemptPromise(that.appLimiter)
			.then(time => appTimeLeft = time)
		);
		let methodTimeLeft = 0;
		attemptPromises.push(
			that._getAttemptPromise(that.methodLimiters[target])
			.then(time => methodTimeLeft = time)
		);

		await Promise.all(attemptPromises);

		let timeLeft = appTimeLeft > methodTimeLeft ? appTimeLeft : methodTimeLeft;

		if(timeLeft > 0)
			await snooze(timeLeft);

		var options = {
		    uri: url,
		    method: 'GET',
		    resolveWithFullResponse : true,
		    qs: qs,
		    headers: {
		        'X-Riot-Token': that.config.key
		    },
		    json: true // Automatically parses the JSON string in the response
		};

		req(options)
		.then(res => {
			console.log('response', res);
			queueItem.callback(res);
		})
		.catch(err => {
			console.error(err);
			queueItem.onError(err);
		})
	}

	if(that.requestQueue.length <= 0)
		that.isProcessing = false;
}

Region.prototype._getLimits = function(limitString) {
	let limitArray = limitString.split(":");
	return {
		maxRequests : parseInt(limitArray[0]), 
		interval : parseInt(limitArray[1]) * 1000
	};
}

Region.prototype._getAttemptPromise = function(explicitLimiter){
	return new Promise((resolve, reject) => {
		explicitLimiter((err, timeLeft, actionsLeft) => {
	        if (err) {
	          resolve(500);
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