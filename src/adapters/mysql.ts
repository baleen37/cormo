var mysql;

try {
  mysql = require('mysql');
} catch (error) {
  console.log('Install mysql module to use this adapter');
  process.exit(1);
}

export interface IAdapterSettingsMySQL {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
  charset?: string;
  collation?: string;
  pool_size?: number;
}

import * as _ from 'lodash';
import * as stream from 'stream';
import * as util from 'util';
import * as types from '../types';
import { SQLAdapterBase } from './sql_base';

function _typeToSQL(property, support_fractional_seconds) {
  if (property.array) {
    return 'TEXT';
  }
  switch (property.type_class) {
    case types.String:
      return `VARCHAR(${property.type.length || 255})`;
    case types.Number:
      return 'DOUBLE';
    case types.Boolean:
      return 'BOOLEAN';
    case types.Integer:
      return 'INT';
    case types.GeoPoint:
      return 'POINT';
    case types.Date:
      if (support_fractional_seconds) {
        return 'DATETIME(3)';
      } else {
        return 'DATETIME';
      }
      break;
    case types.Object:
      return 'TEXT';
    case types.Text:
      return 'TEXT';
  }
}

function _propertyToSQL(property, support_fractional_seconds) {
  var type;
  type = _typeToSQL(property, support_fractional_seconds);
  if (type) {
    if (property.required) {
      type += ' NOT NULL';
    } else {
      type += ' NULL';
    }
    return type;
  }
}

function _processSaveError(error) {
  var key;
  if (error.code === 'ER_NO_SUCH_TABLE') {
    return new Error('table does not exist');
  } else if (error.code === 'ER_DUP_ENTRY') {
    key = error.message.match(/for key '([^']*)'/);
    return new Error('duplicated ' + (key != null ? key[1] : void 0));
  } else if (error.code === 'ER_BAD_NULL_ERROR') {
    key = error.message.match(/Column '([^']*)'/);
    return new Error(`'${(key != null ? key[1] : void 0)}' is required`);
  } else {
    return MySQLAdapter.wrapError('unknown error', error);
  }
}

//#
// Adapter for MySQL
// @namespace adapter
class MySQLAdapter extends SQLAdapterBase {
  key_type = types.Integer;

  support_geopoint = true;

  support_string_type_with_length = true;

  native_integrity = true;

  prototype._escape_ch = '`';

  //#
  // Creates a MySQL adapter
  constructor(connection) {
    super();
    this._connection = connection;
  }

  async _getTables() {
    var tables;
    tables = (await this._client.queryAsync("SHOW TABLES"));
    tables = tables.map(function(table) {
      var key;
      key = Object.keys(table)[0];
      return table[key];
    });
    return tables;
  }

  async _getSchema(table) {
    var column, columns, j, len, schema, type;
    columns = (await this._client.queryAsync(`SHOW COLUMNS FROM \`${table}\``));
    schema = {};
    for (j = 0, len = columns.length; j < len; j++) {
      column = columns[j];
      type = /^varchar\((\d*)\)/i.test(column.Type) ? new types.String(RegExp.$1) : /^double/i.test(column.Type) ? new types.Number() : /^tinyint\(1\)/i.test(column.Type) ? new types.Boolean() : /^int/i.test(column.Type) ? new types.Integer() : /^point/i.test(column.Type) ? new types.GeoPoint() : /^datetime/i.test(column.Type) ? new types.Date() : /^text/i.test(column.Type) ? new types.Object() : void 0;
      schema[column.Field] = {
        type: type,
        required: column.Null === 'NO'
      };
    }
    return schema;
  }

  async _getIndexes() {
    var indexes, indexes_of_table, j, len, name, name1, row, rows;
    rows = (await this._client.queryAsync("SELECT * FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY SEQ_IN_INDEX", [this._database]));
    indexes = {};
    for (j = 0, len = rows.length; j < len; j++) {
      row = rows[j];
      indexes_of_table = indexes[name = row.TABLE_NAME] || (indexes[name] = {});
      (indexes_of_table[name1 = row.INDEX_NAME] || (indexes_of_table[name1] = {}))[row.COLUMN_NAME] = 1;
    }
    return indexes;
  }

  async _getForeignKeys() {
    var foreign_keys, foreign_keys_of_table, j, len, name, row, rows;
    rows = (await this._client.queryAsync("SELECT * FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND CONSTRAINT_SCHEMA = ?", [this._database]));
    foreign_keys = {};
    for (j = 0, len = rows.length; j < len; j++) {
      row = rows[j];
      foreign_keys_of_table = foreign_keys[name = row.TABLE_NAME] || (foreign_keys[name] = {});
      foreign_keys_of_table[row.COLUMN_NAME] = row.REFERENCED_TABLE_NAME;
    }
    return foreign_keys;
  }

  //# @override AdapterBase::getSchemas
  async getSchemas() {
    var foreign_keys, indexes, j, len, table, table_schemas, tables;
    tables = (await this._getTables());
    table_schemas = {};
    for (j = 0, len = tables.length; j < len; j++) {
      table = tables[j];
      table_schemas[table] = (await this._getSchema(table));
    }
    indexes = (await this._getIndexes());
    foreign_keys = (await this._getForeignKeys());
    return {
      tables: table_schemas,
      indexes: indexes,
      foreign_keys: foreign_keys
    };
  }

  //# @override AdapterBase::createTable
  async createTable(model) {
    var column, column_sql, error, model_class, property, ref, sql, tableName;
    model_class = this._connection.models[model];
    tableName = model_class.tableName;
    sql = [];
    sql.push('id INT NOT NULL AUTO_INCREMENT UNIQUE PRIMARY KEY');
    ref = model_class._schema;
    for (column in ref) {
      property = ref[column];
      column_sql = _propertyToSQL(property, this.support_fractional_seconds);
      if (column_sql) {
        sql.push(`\`${property._dbname}\` ${column_sql}`);
      }
    }
    sql = `CREATE TABLE \`${tableName}\` ( ${sql.join(',')} )`;
    sql += ` DEFAULT CHARSET=${this._settings.charset || 'utf8'}`;
    sql += ` COLLATE=${this._settings.collation || 'utf8_unicode_ci'}`;
    try {
      await this._client.queryAsync(sql);
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::addColumn
  async addColumn(model, column_property) {
    var error, model_class, sql, tableName;
    model_class = this._connection.models[model];
    tableName = model_class.tableName;
    sql = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${column_property._dbname}\` ${_propertyToSQL(column_property, this.support_fractional_seconds)}`;
    try {
      await this._client.queryAsync(sql);
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::createIndex
  async createIndex(model, index) {
    var column, columns, error, model_class, order, ref, sql, tableName, unique;
    model_class = this._connection.models[model];
    tableName = model_class.tableName;
    columns = [];
    ref = index.columns;
    for (column in ref) {
      order = ref[column];
      columns.push(`\`${column}\` ${(order === -1 ? 'DESC' : 'ASC')}`);
    }
    unique = index.options.unique ? 'UNIQUE ' : '';
    sql = `CREATE ${unique}INDEX \`${index.options.name}\` ON \`${tableName}\` (${columns.join(',')})`;
    try {
      await this._client.queryAsync(sql);
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::createForeignKey
  async createForeignKey(model, column, type, references) {
    var action, error, model_class, sql, tableName;
    model_class = this._connection.models[model];
    tableName = model_class.tableName;
    action = (function() {
      switch (type) {
        case 'nullify':
          return 'SET NULL';
        case 'restrict':
          return 'RESTRICT';
        case 'delete':
          return 'CASCADE';
      }
    })();
    sql = `ALTER TABLE \`${tableName}\` ADD FOREIGN KEY (\`${column}\`) REFERENCES \`${references.tableName}\`(id) ON DELETE ${action}`;
    try {
      await this._client.queryAsync(sql);
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::drop
  async drop(model) {
    var error, tableName;
    tableName = this._connection.models[model].tableName;
    try {
      await this._client.queryAsync(`DROP TABLE IF EXISTS \`${tableName}\``);
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
  }

  _getModelID(data) {
    return Number(data.id);
  }

  valueToModel(value, property) {
    if (property.type_class === types.Object || property.array) {
      try {
        return JSON.parse(value);
      } catch (error1) {
        return null;
      }
    } else if (property.type_class === types.GeoPoint) {
      return [value.x, value.y];
    } else if (property.type_class === types.Boolean) {
      return value !== 0;
    } else {
      return value;
    }
  }

  _buildUpdateSetOfColumn(property, data, values, fields, places, insert) {
    var dbname, value;
    dbname = property._dbname;
    value = data[dbname];
    if (property.type_class === types.GeoPoint) {
      values.push(value[0]);
      values.push(value[1]);
      if (insert) {
        fields.push(`\`${dbname}\``);
        return places.push('POINT(?,?)');
      } else {
        return fields.push(`\`${dbname}\`=POINT(?,?)`);
      }
    } else if ((value != null ? value.$inc : void 0) != null) {
      values.push(value.$inc);
      return fields.push(`\`${dbname}\`=\`${dbname}\`+?`);
    } else {
      values.push(value);
      if (insert) {
        fields.push(`\`${dbname}\``);
        return places.push('?');
      } else {
        return fields.push(`\`${dbname}\`=?`);
      }
    }
  }

  _buildUpdateSet(model, data, values, insert) {
    var column, fields, places, property, schema;
    schema = this._connection.models[model]._schema;
    fields = [];
    places = [];
    for (column in schema) {
      property = schema[column];
      this._buildUpdateSetOfColumn(property, data, values, fields, places, insert);
    }
    return [fields.join(','), places.join(',')];
  }

  _buildPartialUpdateSet(model, data, values) {
    var column, fields, places, property, schema, value;
    schema = this._connection.models[model]._schema;
    fields = [];
    places = [];
    for (column in data) {
      value = data[column];
      property = _.find(schema, function(item) {
        return item._dbname === column;
      });
      this._buildUpdateSetOfColumn(property, data, values, fields, places);
    }
    return [fields.join(','), places.join(',')];
  }

  //# @override AdapterBase::create
  async create(model, data) {
    var error, fields, id, places, result, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    [fields, places] = this._buildUpdateSet(model, data, values, true);
    sql = `INSERT INTO \`${tableName}\` (${fields}) VALUES (${places})`;
    try {
      result = (await this._client.queryAsync(sql, values));
    } catch (error1) {
      error = error1;
      throw _processSaveError(error);
    }
    if (id = result != null ? result.insertId : void 0) {
      return id;
    } else {
      throw new Error('unexpected result');
    }
  }

  //# @override AdapterBase::createBulk
  async createBulk(model, data) {
    var error, fields, id, places, result, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    fields = void 0;
    places = [];
    data.forEach((item) => {
      var places_sub;
      [fields, places_sub] = this._buildUpdateSet(model, item, values, true);
      return places.push('(' + places_sub + ')');
    });
    sql = `INSERT INTO \`${tableName}\` (${fields}) VALUES ${places.join(',')}`;
    try {
      result = (await this._client.queryAsync(sql, values));
    } catch (error1) {
      error = error1;
      throw _processSaveError(error);
    }
    if (id = result != null ? result.insertId : void 0) {
      return data.map(function(item, i) {
        return id + i;
      });
    } else {
      throw new Error('unexpected result');
    }
  }

  //# @override AdapterBase::update
  async update(model, data) {
    var error, fields, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    [fields] = this._buildUpdateSet(model, data, values);
    values.push(data.id);
    sql = `UPDATE \`${tableName}\` SET ${fields} WHERE id=?`;
    try {
      await this._client.queryAsync(sql, values);
    } catch (error1) {
      error = error1;
      throw _processSaveError(error);
    }
  }

  //# @override AdapterBase::updatePartial
  async updatePartial(model, data, conditions, options) {
    var error, fields, result, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    [fields] = this._buildPartialUpdateSet(model, data, values);
    sql = `UPDATE \`${tableName}\` SET ${fields}`;
    if (conditions.length > 0) {
      try {
        sql += ' WHERE ' + this._buildWhere(this._connection.models[model]._schema, conditions, values);
      } catch (error1) {
        e = error1;
        return callback(e);
      }
    }
    try {
      result = (await this._client.queryAsync(sql, values));
    } catch (error1) {
      error = error1;
      throw _processSaveError(error);
    }
    if (result == null) {
      throw MySQLAdapter.wrapError('unknown error');
    }
    return result.affectedRows;
  }

  //# @override AdapterBase::upsert
  async upsert(model, data, conditions, options) {
    var condition, error, fields, insert_data, j, key, len, places, sql, tableName, value, values;
    tableName = this._connection.models[model].tableName;
    insert_data = {};
    for (key in data) {
      value = data[key];
      if ((value != null ? value.$inc : void 0) != null) {
        insert_data[key] = value.$inc;
      } else {
        insert_data[key] = value;
      }
    }
    for (j = 0, len = conditions.length; j < len; j++) {
      condition = conditions[j];
      for (key in condition) {
        value = condition[key];
        insert_data[key] = value;
      }
    }
    values = [];
    [fields, places] = this._buildUpdateSet(model, insert_data, values, true);
    sql = `INSERT INTO \`${tableName}\` (${fields}) VALUES (${places})`;
    [fields] = this._buildPartialUpdateSet(model, data, values);
    sql += ` ON DUPLICATE KEY UPDATE ${fields}`;
    try {
      await this._client.queryAsync(sql, values);
    } catch (error1) {
      error = error1;
      throw _processSaveError(error);
    }
  }

  //# @override AdapterBase::findById
  async findById(model, id, options) {
    var error, result, select, sql, tableName;
    id = this._convertValueType(id, this.key_type);
    select = this._buildSelect(this._connection.models[model], options.select);
    tableName = this._connection.models[model].tableName;
    sql = `SELECT ${select} FROM \`${tableName}\` WHERE id=? LIMIT 1`;
    if (options.explain) {
      return (await this._client.queryAsync(`EXPLAIN ${sql}`, id));
    }
    try {
      result = (await this._client.queryAsync(sql, id));
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
    if ((result != null ? result.length : void 0) === 1) {
      return this._convertToModelInstance(model, result[0], options);
    } else if ((result != null ? result.length : void 0) > 1) {
      throw new Error('unknown error');
    } else {
      throw new Error('not found');
    }
  }

  _buildSqlForFind(model, conditions, options) {
    var field, location, model_class, order_by, orders, params, schema, select, sql, tableName;
    if (options.group_by || options.group_fields) {
      select = this._buildGroupFields(options.group_by, options.group_fields);
    } else {
      select = this._buildSelect(this._connection.models[model], options.select);
    }
    if ((options.near != null) && (field = Object.keys(options.near)[0])) {
      order_by = `\`${field}_distance\``;
      location = options.near[field];
      select += `,GLENGTH(LINESTRING(\`${field}\`,POINT(${location[0]},${location[1]}))) AS \`${field}_distance\``;
    }
    params = [];
    tableName = this._connection.models[model].tableName;
    sql = `SELECT ${select} FROM \`${tableName}\``;
    if (conditions.length > 0) {
      sql += ' WHERE ' + this._buildWhere(this._connection.models[model]._schema, conditions, params);
    }
    if (options.group_by) {
      sql += ' GROUP BY ' + options.group_by.join(',');
    }
    if (options.conditions_of_group.length > 0) {
      sql += ' HAVING ' + this._buildWhere(options.group_fields, options.conditions_of_group, params);
    }
    if ((options != null ? options.orders.length : void 0) > 0 || order_by) {
      model_class = this._connection.models[model];
      schema = model_class._schema;
      orders = options.orders.map(function(order) {
        var column, ref;
        if (order[0] === '-') {
          column = order.slice(1);
          order = 'DESC';
        } else {
          column = order;
          order = 'ASC';
        }
        column = ((ref = schema[column]) != null ? ref._dbname : void 0) || column;
        return `\`${column}\` ${order}`;
      });
      if (order_by) {
        orders.push(order_by);
      }
      sql += ' ORDER BY ' + orders.join(',');
    }
    if ((options != null ? options.limit : void 0) != null) {
      sql += ' LIMIT ' + options.limit;
      if ((options != null ? options.skip : void 0) != null) {
        sql += ' OFFSET ' + options.skip;
      }
    } else if ((options != null ? options.skip : void 0) != null) {
      sql += ' LIMIT 2147483647 OFFSET ' + options.skip;
    }
    //console.log sql, params
    return [sql, params];
  }

  //# @override AdapterBase::find
  async find(model, conditions, options) {
    var error, params, result, sql;
    [sql, params] = this._buildSqlForFind(model, conditions, options);
    if (options.explain) {
      return (await this._client.queryAsync(`EXPLAIN ${sql}`, params));
    }
    try {
      result = (await this._client.queryAsync(sql, params));
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
    //console.log result
    if (options.group_fields) {
      return result.map((record) => {
        return this._convertToGroupInstance(model, record, options.group_by, options.group_fields);
      });
    } else {
      return result.map((record) => {
        return this._convertToModelInstance(model, record, options);
      });
    }
  }

  //# @override AdapterBase::stream
  stream(model, conditions, options) {
    var params, readable, sql, transformer;
    try {
      [sql, params] = this._buildSqlForFind(model, conditions, options);
    } catch (error1) {
      e = error1;
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
    this._client.query(sql, params).stream().on('error', function(error) {
      return transformer.emit('error', error);
    }).pipe(transformer);
    return transformer;
  }

  //# @override AdapterBase::count
  async count(model, conditions, options) {
    var error, params, result, sql, tableName;
    params = [];
    tableName = this._connection.models[model].tableName;
    sql = `SELECT COUNT(*) AS count FROM \`${tableName}\``;
    if (conditions.length > 0) {
      sql += ' WHERE ' + this._buildWhere(this._connection.models[model]._schema, conditions, params);
    }
    if (options.group_by) {
      sql += ' GROUP BY ' + options.group_by.join(',');
      if (options.conditions_of_group.length > 0) {
        sql += ' HAVING ' + this._buildWhere(options.group_fields, options.conditions_of_group, params);
      }
      sql = `SELECT COUNT(*) AS count FROM (${sql}) _sub`;
    }
    try {
      //console.log sql, params
      result = (await this._client.queryAsync(sql, params));
    } catch (error1) {
      error = error1;
      throw MySQLAdapter.wrapError('unknown error', error);
    }
    if ((result != null ? result.length : void 0) !== 1) {
      throw new Error('unknown error');
    }
    return Number(result[0].count);
  }

  //# @override AdapterBase::delete
  async delete(model, conditions) {
    var error, params, ref, result, sql, tableName;
    params = [];
    tableName = this._connection.models[model].tableName;
    sql = `DELETE FROM \`${tableName}\``;
    if (conditions.length > 0) {
      sql += ' WHERE ' + this._buildWhere(this._connection.models[model]._schema, conditions, params);
    }
    try {
      //console.log sql, params
      result = (await this._client.queryAsync(sql, params));
    } catch (error1) {
      error = error1;
      if (error && ((ref = error.code) === 'ER_ROW_IS_REFERENCED_' || ref === 'ER_ROW_IS_REFERENCED_2')) {
        throw new Error('rejected');
        return;
      }
      throw MySQLAdapter.wrapError('unknown error', error);
    }
    if (result == null) {
      throw MySQLAdapter.wrapError('unknown error');
    }
    return result.affectedRows;
  }

  /**
   * Connects to the database
   */
  public async connect(settings: IAdapterSettingsMySQL) {
    var client, error;
    // connect
    client = mysql.createConnection({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      charset: settings.charset
    });
    client.connectAsync = util.promisify(client.connect);
    client.queryAsync = util.promisify(client.query);
    this._database = settings.database;
    this._settings = settings;
    try {
      await client.connectAsync();
    } catch (error1) {
      error = error1;
      client.end();
      throw MySQLAdapter.wrapError('failed to connect', error);
    }
    try {
      await this._createDatabase(client);
    } catch (error1) {
      error = error1;
      client.end();
      throw error;
    }
    try {
      await this._checkFeatures(client);
    } finally {
      client.end();
    }
    this._client = mysql.createPool({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      charset: settings.charset,
      database: settings.database,
      connectionLimit: settings.pool_size || 10
    });
    this._client.queryAsync = util.promisify(this._client.query);
  }

  // create database if not exist
  async _createDatabase(client) {
    var error, msg;
    try {
      // check database existence
      return (await client.queryAsync(`USE \`${this._database}\``));
    } catch (error1) {
      error = error1;
      if (error.code === 'ER_BAD_DB_ERROR') {
        try {
          await client.queryAsync(`CREATE DATABASE \`${this._database}\``);
        } catch (error1) {
          error = error1;
          throw MySQLAdapter.wrapError('unknown error', error);
        }
        return (await this._createDatabase(client));
      } else {
        msg = error.code === 'ER_DBACCESS_DENIED_ERROR' ? `no access right to the database '${this._database}'` : 'unknown error';
        throw MySQLAdapter.wrapError(msg, error);
      }
    }
  }

  async _checkFeatures(client) {
    var error;
    try {
      await client.queryAsync("CREATE TABLE _temp (date DATETIME(10))");
    } catch (error1) {
      error = error1;
      if (error.code === 'ER_PARSE_ERROR') {
        // MySQL 5.6.4 below does not support fractional seconds
        this.support_fractional_seconds = false;
      } else if (error.code === 'ER_TOO_BIG_PRECISION') {
        this.support_fractional_seconds = true;
      } else {
        throw error;
      }
    }
  }

  public close() {
    if (this._client) {
      this._client.end();
    }
    return this._client = null;
  }

  /**
   * Exposes mysql module's query method
   */
  public query() {
    return this._client.queryAsync.apply(this._client, arguments);
  }
}

export default (connection) => {
  return new MySQLAdapter(connection);
};