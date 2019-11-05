# TeetoJS

TeetoJS is a lightweight Node.js Riot API wrapper, ready for multi-instances szenarios with the help of redis.
It has around 300 lines of code only, offers priority queuing of API requests, an integrated rate-limiter and is easy to customize.

## Installation

```sh
npm install teetojs --save
```

## Usage

```node
const TeetoJS = require("teetojs");
let api = TeetoJS("RGAPI-KEY-HERE", {
  redis: {
    host: "YOUR-HOSTNAME",
    port: 6379, // or whatever port you have
    db: 1,
    password: "YOUR-PASSWORD"
  }
});

api
  .get("euw", "summoner.getBySummonerName", encodeURIComponent("TheCraccer"))
  .then(res => console.log(res))
  .catch(err => console.log(err));

api
  .get("na1", "match.getMatchlist", 0, 78247)
  .then(res => console.log(res))
  .catch(err => console.log(err));
```

All requests are done via `.get(...)`.

- The first argument is the region.
- The second is the `endpoint` path
  (see [`config.json`](https://github.com/GameBuddyApp/teetoJS/blob/master/config.json)).
- The third argument is the priority of the request. 1 for high, 0 for normal
- Then come any path arguments (usually zero or one, or two for `getChampionMastery`) which are for
  summoner/match IDs, names, etc.
- Last is an optional object for any query parameters.
  (Important: You should encode names when searching for summoners, because some characters need to be encoded to be found from riot)

## Configuration

To customize the wrapper `TeetoJS` takes options as second argument which is a configuration object.
[`config.json`](https://github.com/GameBuddyApp/teetoJS/blob/master/config.json)
is used by default. The supplied `option` object will override any corresponding values in the `config`.
The configuration specifies the number of retries, backOffTimings, loggings, endpoints, your redis config and everything else.
You should at least give your valid redis config to make the wrapper work.

### `config` Object

- `debug` [boolean]: Weather to show debug outputs or not
- `namespacePrefix` [string]: Add a prefix if you have multiple limits running that need to be counted seperately. NOTE: Dev and Prod environments are already seperated via environment variables
- `showWarn` [boolean]: Weather to console.error occuring 429 errors or not
- `exceededCallback` [func(err)]: Callback to be called if a 429 error appeared. Parameter is an error object containing `headers` and `url`
- `applimit` [array]: Your apiKey application limits, e.g. ["20:1","100:120"]
- `spreadToSlowest` [boolean]: All requests are spreaded according to your slowest limit. Set this value to `false` to only respect your smaller limits (e.g. your 10s limit). Recommendation: Use `true` for production
- `edgeCaseFixValue` [number]: Since Riot resets it's limits by their own time there is a small [`edge case`](https://imgur.com/a/whIAu) where requests are resetted in the wrapper but not at riot. This value slows down your requests, so that this does not happen to often. A value of `1.1` means that you are running at 90% speed. WARNING: Setting this value very low might cause 429-errors.
- `maxRetriesAmnt` [number]: Number of retries after getting a 429, 500 or 503 error before aborting the request
- `retryMS` [number]: Default time before retrying a failed request. This value only applies to 429 retries if `retry-after` is not given in the riot response

### Rate-Limiting

To rate limit all your requests accross multiple instances, this wrapper is using a modified version of the [`rolling-rate-limiter`](https://github.com/classdojo/rolling-rate-limiter) from classdojo.
