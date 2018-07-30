import { tableize } from '../util/inflector';

/**
 * Model cache
 * @namespace model
 */
class ModelCache {
  static async _loadFromCache(key, refresh) {
    var redis, value;
    if (refresh) {
      throw new Error('error');
    }
    redis = (await this._connection._connectRedisCache());
    key = 'CC.' + tableize(this._name) + ':' + key;
    value = (await new Promise(function(resolve, reject) {
      return redis.get(key, function(error, value) {
        if (error) {
          return reject(error);
        }
        return resolve(value);
      });
    }));
    if (value == null) {
      throw new Error('error');
    }
    return JSON.parse(value);
  }

  static async _saveToCache(key, ttl, data) {
    var redis;
    redis = (await this._connection._connectRedisCache());
    key = 'CC.' + tableize(this._name) + ':' + key;
    return (await new Promise(function(resolve, reject) {
      return redis.setex(key, ttl, JSON.stringify(data), function(error) {
        if (error) {
          return reject(error);
        }
        return resolve();
      });
    }));
  }

  static async removeCache(key) {
    var redis;
    redis = (await this._connection._connectRedisCache());
    key = 'CC.' + tableize(this._name) + ':' + key;
    return (await new Promise(function(resolve, reject) {
      return redis.del(key, function(error, count) {
        return resolve();
      });
    }));
  }
}

export { ModelCache };
