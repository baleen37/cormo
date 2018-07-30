var redis;

try {
  redis = require('redis');
} catch (error) {
  console.log('Install redis module to use this adapter');
  process.exit(1);
}

import * as _ from 'lodash';
import * as util from 'util';
import * as types from '../types';
import { tableize } from '../util/inflector';
import { AdapterBase } from './base';

//#
// Adapter for Redis
// @namespace adapter
class RedisAdapter extends AdapterBase {
  support_upsert = false;

  key_type = types.Integer;

  async _getKeys(table, conditions) {
    var all_keys;
    if (Array.isArray(conditions)) {
      if (conditions.length === 0) {
        return (await this._client.keysAsync(`${table}:*`));
      }
      all_keys = [];
      await Promise.all(conditions.map(async (condition) => {
        var keys;
        keys = (await this._getKeys(table, condition));
        [].push.apply(all_keys, keys);
      }));
      return all_keys;
    } else if (typeof conditions === 'object' && conditions.id) {
      if (conditions.id.$in) {
        return conditions.id.$in.map(function(id) {
          return `${table}:${id}`;
        });
      } else {
        return [`${table}:${conditions.id}`];
      }
    }
    return [];
  }

  //#
  // Creates a Redis adapter
  constructor(connection) {
    super();
    this._connection = connection;
  }

  //# @override AdapterBase::drop
  drop(model) {
    return this.delete(model, []);
  }

  valueToDB(value, column, property) {
    if (value == null) {
      return;
    }
    switch (property.type_class) {
      case types.Number:
      case types.Integer:
        return value.toString();
      case types.Date:
        return new Date(value).getTime().toString();
      case types.Boolean:
        if (value) {
          return '1';
        } else {
          return '0';
        }
        break;
      case types.Object:
        return JSON.stringify(value);
      default:
        return value;
    }
  }

  valueToModel(value, property) {
    switch (property.type_class) {
      case types.Number:
      case types.Integer:
        return Number(value);
      case types.Date:
        return new Date(Number(value));
      case types.Boolean:
        return value !== '0';
      case types.Object:
        return JSON.parse(value);
      default:
        return value;
    }
  }

  //# @override AdapterBase::create
  async create(model, data) {
    var id;
    data.$_$ = ''; // ensure that there is one argument(one field) at least
    try {
      id = (await this._client.incrAsync(`${tableize(model)}:_lastid`));
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
    try {
      await this._client.hmsetAsync(`${tableize(model)}:${id}`, data);
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
    return id;
  }

  //# @override AdapterBase::createBulk
  async createBulk(model, data) {
    return (await this._createBulkDefault(model, data));
  }

  //# @override AdapterBase::update
  async update(model, data) {
    var exists, key;
    key = `${tableize(model)}:${data.id}`;
    delete data.id;
    data.$_$ = ''; // ensure that there is one argument(one field) at least
    try {
      exists = (await this._client.existsAsync(key));
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
    if (!exists) {
      return;
    }
    try {
      await this._client.delAsync(key);
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
    try {
      await this._client.hmsetAsync(key, data);
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::updatePartial
  async updatePartial(model, data, conditions, options) {
    var args, fields_to_del, i, key, keys, len, table;
    fields_to_del = Object.keys(data).filter(function(key) {
      return data[key] == null;
    });
    fields_to_del.forEach(function(key) {
      return delete data[key];
    });
    fields_to_del.push('$_$'); // ensure that there is one argument at least
    table = tableize(model);
    data.$_$ = ''; // ensure that there is one argument(one field) at least
    keys = (await this._getKeys(table, conditions));
    for (i = 0, len = keys.length; i < len; i++) {
      key = keys[i];
      args = _.clone(fields_to_del);
      args.unshift(key);
      try {
        await this._client.hdelAsync(args);
      } catch (error1) {
        error = error1;
        if (error) {
          throw RedisAdapter.wrapError('unknown error', error);
        }
      }
      try {
        await this._client.hmsetAsync(key, data);
      } catch (error1) {
        error = error1;
        if (error) {
          throw RedisAdapter.wrapError('unknown error', error);
        }
      }
    }
    return keys.length;
  }

  //# @override AdapterBase::findById
  async findById(model, id, options) {
    var result;
    try {
      result = (await this._client.hgetallAsync(`${tableize(model)}:${id}`));
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
    if (result) {
      result.id = id;
      return this._convertToModelInstance(model, result, options);
    } else {
      throw new Error('not found');
    }
  }

  //# @override AdapterBase::find
  async find(model, conditions, options) {
    var keys, records, table;
    table = tableize(model);
    keys = (await this._getKeys(table, conditions));
    records = (await Promise.all(keys.map(async (key) => {
      var result;
      result = (await this._client.hgetallAsync(key));
      if (result) {
        result.id = Number(key.substr(table.length + 1));
      }
      return result;
    })));
    records = records.filter(function(record) {
      return record != null;
    });
    return records.map((record) => {
      return this._convertToModelInstance(model, record, options);
    });
  }

  //# @override AdapterBase::delete
  async delete(model, conditions) {
    var count, keys;
    keys = (await this._getKeys(tableize(model), conditions));
    if (keys.length === 0) {
      return 0;
    }
    try {
      count = (await this._client.delAsync(keys));
    } catch (error1) {
      error = error1;
      throw RedisAdapter.wrapError('unknown error', error);
    }
    return count;
  }

  //#
  // Connects to the database
  // @param {Object} settings
  // @param {String} [settings.host='127.0.0.1']
  // @param {Number} [settings.port=6379]
  // @param {Number} [settings.database=0]
  async connect(settings) {
    var i, len, method, methods;
    methods = ['del', 'exists', 'hdel', 'hgetall', 'hmset', 'incr', 'keys', 'select'];
    this._client = redis.createClient(settings.port || 6379, settings.host || '127.0.0.1');
    for (i = 0, len = methods.length; i < len; i++) {
      method = methods[i];
      this._client[method + 'Async'] = util.promisify(this._client[method]);
    }
    return (await this._client.selectAsync(settings.database || 0));
  }
}

export default (connection) => {
  return new RedisAdapter(connection);
};
