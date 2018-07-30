// tslint:disable:max-classes-per-file

var ObjectID, mongodb;

try {
  mongodb = require('mongodb');
} catch (error) {
  console.log('Install mongodb module to use this adapter');
  process.exit(1);
}

ObjectID = mongodb.ObjectID;

class CormoTypesObjectId { }

import * as _ from 'lodash';
import * as stream from 'stream';
import * as types from '../types';
import { AdapterBase } from './base';

function _convertValueToObjectID(value, key) {
  if (value == null) {
    return null;
  }
  try {
    return new ObjectID(value);
  } catch (error) {
    throw new Error(`'${key}' is not a valid id`);
  }
}

function _objectIdToString(oid) {
  return oid.toString();
}

function _buildWhereSingle(property, key, value, not_op) {
  var is_objectid, keys, property_type_class, sub_key, sub_value;
  if (key !== 'id' && (property == null)) {
    throw new Error(`unknown column '${key}'`);
  }
  property_type_class = property != null ? property.type_class : void 0;
  is_objectid = key === 'id' || property_type_class === CormoTypesObjectId;
  if (Array.isArray(value)) {
    if (is_objectid) {
      value = value.map(function(v) {
        return _convertValueToObjectID(v, key);
      });
    }
    if (not_op) {
      value = {
        $nin: value
      };
    } else {
      value = {
        $in: value
      };
    }
  } else if (typeof value === 'object' && value !== null && (keys = Object.keys(value)).length === 1) {
    sub_key = keys[0];
    switch (sub_key) {
      case '$not':
        return _buildWhereSingle(property, key, value[sub_key], !not_op);
      case '$gt':
      case '$lt':
      case '$gte':
      case '$lte':
        sub_value = value[sub_key];
        if (is_objectid) {
          sub_value = _convertValueToObjectID(sub_value, key);
        } else if (property_type_class === types.Date) {
          sub_value = new Date(sub_value);
        }
        value = _.zipObject([sub_key], [sub_value]);
        if (not_op) {
          value = {
            $not: value
          };
        }
        if (key === 'id') {
          key = '_id';
        }
        return _.zipObject([key], [value]);
      case '$contains':
        if (Array.isArray(value[sub_key])) {
          value = value[sub_key].map(function(v) {
            return new RegExp(v, 'i');
          });
          if (not_op) {
            value = {
              $nin: value
            };
            not_op = false;
          } else {
            value = {
              $in: value
            };
          }
        } else {
          value = new RegExp(value[sub_key], 'i');
        }
        break;
      case '$startswith':
        value = new RegExp('^' + value[sub_key], 'i');
        break;
      case '$endswith':
        value = new RegExp(value[sub_key] + '$', 'i');
        break;
      case '$in':
        if (is_objectid) {
          value[sub_key] = value[sub_key].map(function(v) {
            return _convertValueToObjectID(v, key);
          });
        }
        break;
      default:
        throw new Error(`unknown operator '${sub_key}'`);
    }
    if (not_op) {
      value = {
        $not: value
      };
    }
  } else if (_.isRegExp(value)) {
    if (!value.ignoreCase) {
      value = new RegExp(value.source, 'i');
    }
  } else {
    if (is_objectid) {
      value = _convertValueToObjectID(value, key);
    }
    if (not_op) {
      value = {
        $ne: value
      };
    }
  }
  if (key === 'id') {
    key = '_id';
  }
  if (property_type_class === types.Date) {
    value = new Date(value);
  }
  return _.zipObject([key], [value]);
}

function _buildWhere(schema, conditions, conjunction = '$and') {
  var after_count, before_count, key, keys, obj, subs;
  if (Array.isArray(conditions)) {
    subs = conditions.map(function(condition) {
      return _buildWhere(schema, condition);
    });
  } else if (typeof conditions === 'object') {
    keys = Object.keys(conditions);
    if (keys.length === 0) {
      return;
    } else if (keys.length === 1) {
      key = keys[0];
      if (key.substr(0, 1) === '$') {
        switch (key) {
          case '$and':
            return _buildWhere(schema, conditions[key], '$and');
          case '$or':
            return _buildWhere(schema, conditions[key], '$or');
        }
        return;
      } else {
        return _buildWhereSingle(schema[key], key, conditions[key]);
      }
    } else {
      subs = keys.map(function(key) {
        return _buildWhereSingle(schema[key], key, conditions[key]);
      });
    }
  } else {
    throw new Error(`'${JSON.stringify(conditions)}' is not an object`);
  }
  if (subs.length === 0) {

  } else if (subs.length === 1) {
    return subs[0];
  } else {
    if (conjunction === '$and') {
      before_count = _.reduce(subs, (function(memo, sub) {
        return memo + Object.keys(sub).length;
      }), 0);
      subs.unshift({});
      obj = _.extend.apply(_, subs);
      subs.shift();
      keys = Object.keys(obj);
      after_count = keys.length;
      if (before_count === after_count && !_.some(keys, function(key) {
        return key.substr(0, 1) === '$';
      })) {
        return obj;
      }
    }
    return _.zipObject([conjunction], [subs]);
  }
}

function _buildGroupFields(group_by, group_fields) {
  var expr, field, group;
  group = {};
  if (group_by) {
    if (group_by.length === 1) {
      group._id = '$' + group_by[0];
    } else {
      group._id = {};
      group_by.forEach(function(field) {
        return group._id[field] = '$' + field;
      });
    }
  } else {
    group._id = null;
  }
  for (field in group_fields) {
    expr = group_fields[field];
    group[field] = expr;
  }
  return group;
}

function _processSaveError(error) {
  var key, ref;
  if ((ref = error != null ? error.code : void 0) === 11001 || ref === 11000) {
    key = error.message.match(/collection: [\w-.]+ index: (\w+)/);
    if (!key) {
      key = error.message.match(/index: [\w-.]+\$(\w+)(_1)?/);
    }
    return new Error('duplicated ' + (key != null ? key[1] : void 0));
  } else {
    return MongoDBAdapter.wrapError('unknown error', error);
  }
}

function _getMongoDBColName(name) {
  // there is a problem with name begins with underscore
  if (name === '_archives') {
    return '@archives';
  } else {
    return name;
  }
}

//#
// Adapter for MongoDB
// @namespace adapter
class MongoDBAdapter extends AdapterBase {
  key_type = types.String;

  key_type_internal = CormoTypesObjectId;

  support_geopoint = true;

  support_nested = true;

  //#
  // Creates a MongoDB adapter
  constructor(connection) {
    super();
    this._connection = connection;
    this._collections = {};
  }

  _collection(model) {
    var name;
    name = this._connection.models[model].tableName;
    if (!this._collections[name]) {
      return this._collections[name] = this._db.collection(_getMongoDBColName(name));
    } else {
      return this._collections[name];
    }
  }

  async _getTables() {
    var collections, tables;
    collections = (await this._db.listCollections().toArray());
    tables = collections.map(function(collection) {
      return collection.name;
    });
    return tables;
  }

  async _getSchema(table) {
    return (await 'NO SCHEMA');
  }

  async _getIndexes(table) {
    var indexes, j, len, row, rows;
    rows = (await this._db.collection(table).listIndexes().toArray());
    indexes = {};
    for (j = 0, len = rows.length; j < len; j++) {
      row = rows[j];
      indexes[row.name] = row.key;
    }
    return indexes;
  }

  //# @override AdapterBase::getSchemas
  async getSchemas() {
    var all_indexes, j, len, table, table_schemas, tables;
    tables = (await this._getTables());
    table_schemas = {};
    all_indexes = {};
    for (j = 0, len = tables.length; j < len; j++) {
      table = tables[j];
      table_schemas[table] = (await this._getSchema(table));
      all_indexes[table] = (await this._getIndexes(table));
    }
    return {
      tables: table_schemas,
      indexes: all_indexes
    };
  }

  //# @override AdapterBase::createTable
  async createTable(model) {
    var collection, column, index, indexes, j, len, property, ref;
    collection = this._collection(model);
    indexes = [];
    ref = this._connection.models[model]._schema;
    for (column in ref) {
      property = ref[column];
      if (property.type_class === types.GeoPoint) {
        indexes.push([_.zipObject([column], ['2d'])]);
      }
    }
    for (j = 0, len = indexes.length; j < len; j++) {
      index = indexes[j];
      await collection.ensureIndex(index[0], index[1]);
    }
  }

  //# @override AdapterBase::createIndex
  async createIndex(model, index) {
    var collection, options;
    collection = this._collection(model);
    options = {
      name: index.options.name,
      unique: index.options.unique
    };
    if (index.options.unique && !index.options.required) {
      options.sparse = true;
    }
    try {
      await collection.ensureIndex(index.columns, options);
    } catch (error) {
      throw MongoDBAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::drop
  async drop(model) {
    var name;
    name = this._connection.models[model].tableName;
    delete this._collections[name];
    try {
      await this._db.dropCollection(_getMongoDBColName(name));
    } catch (error) {
      // ignore not found error
      if (error && error.errmsg !== 'ns not found') {
        throw MongoDBAdapter.wrapError('unknown error', error);
      }
    }
  }

  idToDB(value) {
    return _convertValueToObjectID(value, 'id');
  }

  valueToDB(value, column, property) {
    if (value == null) {
      return;
    }
    // convert id type
    if (column === 'id' || property.type_class === CormoTypesObjectId) {
      if (property.array) {
        return value.map(function(v) {
          return v && _convertValueToObjectID(v, column);
        });
      } else {
        return _convertValueToObjectID(value, column);
      }
    }
    return value;
  }

  _getModelID(data) {
    return _objectIdToString(data._id);
  }

  valueToModel(value, property) {
    if (property.type_class === CormoTypesObjectId) {
      if (property.array) {
        return value.map(function(v) {
          return v && _objectIdToString(v);
        });
      } else {
        return value && _objectIdToString(value);
      }
    } else {
      return value;
    }
  }

  //# @override AdapterBase::create
  async create(model, data) {
    var id, result;
    try {
      result = (await this._collection(model).insert(data, {
        safe: true
      }));
    } catch (error) {
      throw _processSaveError(error);
    }
    id = _objectIdToString(result.ops[0]._id);
    if (id) {
      delete data._id;
      return id;
    } else {
      throw new Error('unexpected result');
    }
  }

  //# @override AdapterBase::create
  async createBulk(model, data) {
    var chunk, chunks, i, ids, ids_all, j, len, result;
    if (data.length > 1000) {
      chunks = [];
      i = 0;
      while (i < data.length) {
        chunks.push(data.slice(i, i + 1000));
        i += 1000;
      }
      ids_all = [];
      for (j = 0, len = chunks.length; j < len; j++) {
        chunk = chunks[j];
        ids = (await this.createBulk(model, chunk));
        [].push.apply(ids_all, ids);
      }
      return ids_all;
    }
    try {
      result = (await this._collection(model).insert(data, {
        safe: true
      }));
    } catch (error) {
      throw _processSaveError(error);
    }
    let error;
    ids = result.ops.map(function(doc) {
      var id;
      id = _objectIdToString(doc._id);
      if (id) {
        delete data._id;
      } else {
        error = new Error('unexpected result');
      }
      return id;
    });
    if (error) {
      throw error;
    } else {
      return ids;
    }
  }

  //# @override AdapterBase::update
  async update(model, data) {
    var id;
    id = data.id;
    delete data.id;
    try {
      await this._collection(model).update({
        _id: id
      }, data, {
          safe: true
        });
    } catch (error) {
      throw _processSaveError(error);
    }
  }

  _buildUpdateOps(schema, update_ops, data, path, object) {
    var column, property, results, value;
    results = [];
    for (column in object) {
      value = object[column];
      property = schema[path + column];
      if (property) {
        if (value != null) {
          if (value.$inc != null) {
            results.push(update_ops.$inc[path + column] = value.$inc);
          } else {
            results.push(update_ops.$set[path + column] = value);
          }
        } else {
          results.push(update_ops.$unset[path + column] = '');
        }
      } else if (typeof object[column] === 'object') {
        results.push(this._buildUpdateOps(schema, update_ops, data, path + column + '.', object[column]));
      } else {
        results.push(void 0);
      }
    }
    return results;
  }

  //# @override AdapterBase::updatePartial
  async updatePartial(model, data, conditions, options) {
    var result, schema, update_ops;
    schema = this._connection.models[model]._schema;
    conditions = _buildWhere(schema, conditions);
    if (!conditions) {
      conditions = {};
    }
    update_ops = {
      $set: {},
      $unset: {},
      $inc: {}
    };
    this._buildUpdateOps(schema, update_ops, data, '', data);
    if (Object.keys(update_ops.$set).length === 0) {
      delete update_ops.$set;
    }
    if (Object.keys(update_ops.$unset).length === 0) {
      delete update_ops.$unset;
    }
    if (Object.keys(update_ops.$inc).length === 0) {
      delete update_ops.$inc;
    }
    try {
      result = (await this._collection(model).update(conditions, update_ops, {
        safe: true,
        multi: true
      }));
      return result.result.n;
    } catch (error) {
      throw _processSaveError(error);
    }
  }

  //# @override AdapterBase::upsert
  async upsert(model, data, conditions, options) {
    var e, key, schema, update_ops, value;
    schema = this._connection.models[model]._schema;
    conditions = _buildWhere(schema, conditions);
    if (!conditions) {
      conditions = {};
    }
    update_ops = {
      $set: {},
      $unset: {},
      $inc: {}
    };
    for (key in conditions) {
      value = conditions[key];
      update_ops.$set[key] = value;
    }
    this._buildUpdateOps(schema, update_ops, data, '', data);
    if (Object.keys(update_ops.$set).length === 0) {
      delete update_ops.$set;
    }
    if (Object.keys(update_ops.$unset).length === 0) {
      delete update_ops.$unset;
    }
    if (Object.keys(update_ops.$inc).length === 0) {
      delete update_ops.$inc;
    }
    try {
      await this._collection(model).update(conditions, update_ops, {
        safe: true,
        upsert: true
      });
    } catch (error) {
      throw _processSaveError(error);
    }
  }

  //# @override AdapterBase::findById
  async findById(model, id, options) {
    var client_options, e, fields, result;
    if (options.select) {
      fields = {};
      options.select.forEach(function(column) {
        return fields[column] = 1;
      });
    }
    try {
      id = _convertValueToObjectID(id, 'id');
    } catch (error) {
      throw new Error('not found');
    }
    client_options = {};
    if (fields) {
      client_options.fields = fields;
    }
    if (options.explain) {
      client_options.explain = true;
      return (await this._collection(model).findOne({
        _id: id
      }, client_options));
    }
    try {
      result = (await this._collection(model).findOne({
        _id: id
      }, client_options));
    } catch (error) {
      throw MongoDBAdapter.wrapError('unknown error', error);
    }
    if (!result) {
      throw new Error('not found');
      return;
    }
    return this._convertToModelInstance(model, result, options);
  }

  _buildConditionsForFind(model, conditions, options) {
    var client_options, field, fields, keys, obj, orders;
    if (options.select) {
      fields = {};
      options.select.forEach(function(column) {
        return fields[column] = 1;
      });
    }
    conditions = _buildWhere(this._connection.models[model]._schema, conditions);
    if ((options.near != null) && (field = Object.keys(options.near)[0])) {
      if (conditions) {
        // MongoDB fails if $near is mixed with $and
        keys = Object.keys(conditions);
      }
      if (keys && (keys.length > 1 || keys[0].substr(0, 1) !== '$')) {
        conditions[field] = {
          $near: options.near[field]
        };
      } else {
        obj = {};
        obj[field] = {
          $near: options.near[field]
        };
        if (conditions) {
          conditions = {
            $and: [conditions, obj]
          };
        } else {
          conditions = obj;
        }
      }
    }
    if (options.orders.length > 0) {
      orders = {};
      options.orders.forEach(function(order) {
        var column, dir;
        if (order[0] === '-') {
          column = order.slice(1);
          dir = -1;
        } else {
          column = order;
          dir = 1;
        }
        if (options.group_by) {
          if (options.group_by.length === 1) {
            if (column === options.group_by[0]) {
              column = '_id';
            }
          } else {
            if (options.group_by.indexOf(column) >= 0) {
              column = '_id.' + column;
            }
          }
        } else {
          if (column === 'id') {
            column = '_id';
          }
        }
        return orders[column] = dir;
      });
    }
    client_options = {
      limit: options.limit,
      skip: options.skip
    };
    if (fields) {
      client_options.fields = fields;
    }
    if (orders) {
      client_options.sort = orders;
    }
    return [conditions, fields, orders, client_options];
  }

  //# @override AdapterBase::find
  async find(model, conditions, options) {
    var client_options, cursor, fields, orders, pipeline, result;
    [conditions, fields, orders, client_options] = this._buildConditionsForFind(model, conditions, options);
    //console.log JSON.stringify conditions
    if (options.group_by || options.group_fields) {
      pipeline = [];
      if (conditions) {
        pipeline.push({
          $match: conditions
        });
      }
      pipeline.push({
        $group: _buildGroupFields(options.group_by, options.group_fields)
      });
      if (orders) {
        pipeline.push({
          $sort: orders
        });
      }
      if (options.conditions_of_group.length > 0) {
        pipeline.push({
          $match: _buildWhere(options.group_fields, options.conditions_of_group)
        });
      }
      if (options.limit) {
        pipeline.push({
          $limit: options.limit
        });
      }
      if (options.explain) {
        cursor = (await this._collection(model).aggregate(pipeline, {
          explain: true
        }));
        return (await cursor.toArray());
      }
      try {
        cursor = (await this._collection(model).aggregate(pipeline));
      } catch (error) {
        throw MongoDBAdapter.wrapError('unknown error', error);
      }
      result = (await cursor.toArray());
      return result.map((record) => {
        var group, j, len, ref;
        if (options.group_by) {
          if (options.group_by.length === 1) {
            record[options.group_by[0]] = record._id;
          } else {
            ref = options.group_by;
            for (j = 0, len = ref.length; j < len; j++) {
              group = ref[j];
              record[group] = record._id[group];
            }
          }
        }
        return this._convertToGroupInstance(model, record, options.group_by, options.group_fields);
      });
    } else {
      if (options.explain) {
        client_options.explain = true;
        cursor = (await this._collection(model).find(conditions, client_options));
        return (await cursor.toArray());
      }
      try {
        cursor = (await this._collection(model).find(conditions, client_options));
      } catch (error) {
        throw MongoDBAdapter.wrapError('unknown error', error);
      }
      if (!cursor) {
        throw MongoDBAdapter.wrapError('unknown error');
      }
      try {
        result = (await cursor.toArray());
      } catch (error) {
        throw MongoDBAdapter.wrapError('unknown error', error);
      }
      return result.map((record) => {
        return this._convertToModelInstance(model, record, options);
      });
    }
  }

  //# @override AdapterBase::stream
  stream(model, conditions, options) {
    var client_options, fields, orders, readable, transformer;
    try {
      [conditions, fields, orders, client_options] = this._buildConditionsForFind(model, conditions, options);
    } catch (e) {
      readable = new stream.Readable({
        objectMode: true
      });
      readable._read = function() {
        return readable.emit('error', e);
      };
      return readable;
    }
    transformer = new stream.Transform({
      objectMode: true
    });
    transformer._transform = (record, encoding, callback) => {
      transformer.push(this._convertToModelInstance(model, record, options));
      return callback();
    };
    this._collection(model).find(conditions, client_options, function(error, cursor) {
      if (error || !cursor) {
        transformer.emit('error', MongoDBAdapter.wrapError('unknown error', error));
        return;
      }
      return cursor.on('error', function(error) {
        return transformer.emit('error', error);
      }).pipe(transformer);
    });
    return transformer;
  }

  //# @override AdapterBase::count
  async count(model, conditions, options) {
    var count, cursor, pipeline, result;
    conditions = _buildWhere(this._connection.models[model]._schema, conditions);
    //console.log JSON.stringify conditions
    if (options.group_by || options.group_fields) {
      pipeline = [];
      if (conditions) {
        pipeline.push({
          $match: conditions
        });
      }
      pipeline.push({
        $group: _buildGroupFields(options.group_by, options.group_fields)
      });
      if (options.conditions_of_group.length > 0) {
        pipeline.push({
          $match: _buildWhere(options.group_fields, options.conditions_of_group)
        });
      }
      pipeline.push({
        $group: {
          _id: null,
          count: {
            $sum: 1
          }
        }
      });
      try {
        cursor = (await this._collection(model).aggregate(pipeline));
      } catch (error) {
        throw MongoDBAdapter.wrapError('unknown error', error);
      }
      result = (await cursor.toArray());
      if ((result != null ? result.length : void 0) !== 1) {
        throw new Error('unknown error');
      }
      return result[0].count;
    } else {
      try {
        count = (await this._collection(model).countDocuments(conditions));
      } catch (error) {
        throw MongoDBAdapter.wrapError('unknown error', error);
      }
      return count;
    }
  }

  //# @override AdapterBase::delete
  async delete(model, conditions) {
    var model_class, result;
    model_class = this._connection.models[model];
    conditions = _buildWhere(model_class._schema, conditions);
    try {
      //console.log JSON.stringify conditions
      result = (await this._collection(model).remove(conditions, {
        safe: true
      }));
    } catch (error) {
      throw MongoDBAdapter.wrapError('unknown error', error);
    }
    return result.result.n;
  }

  //#
  // Connects to the database
  // @param {Object} settings
  // @param {String} [settings.host='localhost']
  // @param {Number} [settings.port=27017]
  // @param {String} [settings.user]
  // @param {String} [settings.password]
  // @param {String} settings.database
  async connect(settings) {
    var client, url;
    if (settings.user || settings.password) {
      url = `mongodb://${settings.user}:${settings.password}@${settings.host || 'localhost'}:${settings.port || 27017}/${settings.database}`;
    } else {
      url = `mongodb://${settings.host || 'localhost'}:${settings.port || 27017}/${settings.database}`;
    }
    try {
      client = (await mongodb.MongoClient.connect(url, {
        useNewUrlParser: true
      }));
    } catch (error) {
      throw MongoDBAdapter.wrapError('unknown error', error);
    }
    this._client = client;
    this._db = client.db(settings.database);
  }

  //# @override AdapterBase::close
  close() {
    if (this._client) {
      this._client.close();
    }
    this._client = null;
    return this._db = null;
  }

  //#
  // Exposes mongodb module's a collection object
  collection(model) {
    return this._collection(model);
  }
}

export default (connection) => {
  return new MongoDBAdapter(connection);
};
