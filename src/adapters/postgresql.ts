var QueryStream, pg;

try {
  pg = require('pg');
} catch (error) {
  console.log('Install pg module to use this adapter');
  process.exit(1);
}

try {
  QueryStream = require('pg-query-stream');
} catch (error) { }

export interface IAdapterSettingsPostgreSQL {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
}

import * as _ from 'lodash';
import * as stream from 'stream';
import * as types from '../types';
import { SQLAdapterBase } from './sql_base';

function _typeToSQL(property) {
  if (property.array) {
    return 'JSON';
  }
  switch (property.type_class) {
    case types.String:
      return `VARCHAR(${property.type.length || 255})`;
    case types.Number:
      return 'DOUBLE PRECISION';
    case types.Boolean:
      return 'BOOLEAN';
    case types.Integer:
      return 'INT';
    case types.GeoPoint:
      return 'GEOMETRY(POINT)';
    case types.Date:
      return 'TIMESTAMP WITHOUT TIME ZONE';
    case types.Object:
      return 'JSON';
    case types.Text:
      return 'TEXT';
  }
}

function _propertyToSQL(property) {
  var type;
  type = _typeToSQL(property);
  if (type) {
    if (property.required) {
      type += ' NOT NULL';
    } else {
      type += ' NULL';
    }
    return type;
  }
}

function _processSaveError(tableName, error) {
  var column, key;
  if (error.code === '42P01') {
    return new Error('table does not exist');
  } else if (error.code === '23505') {
    column = '';
    key = error.message.match(/unique constraint \"(.*)\"/);
    if (key != null) {
      column = key[1];
      key = column.match(new RegExp(`${tableName}_([^']*)_key`));
      if (key != null) {
        column = key[1];
      }
      column = ' ' + column;
    }
    return new Error('duplicated' + column);
  } else {
    return PostgreSQLAdapter.wrapError('unknown error', error);
  }
}

//#
// Adapter for PostgreSQL
// @namespace adapter
class PostgreSQLAdapter extends SQLAdapterBase {
  key_type = types.Integer;

  support_geopoint = true;

  support_string_type_with_length = true;

  native_integrity = true;

  _contains_op = 'ILIKE';

  _regexp_op = '~*';

  _param_place_holder(pos) {
    return '$' + pos;
  }

  //#
  // Creates a PostgreSQL adapter
  constructor(connection) {
    super();
    this._connection = connection;
  }

  async _getTables() {
    var result, tables;
    result = (await this._pool.query("SELECT table_name FROM INFORMATION_SCHEMA.TABLES WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"));
    tables = result.rows.map(function(table) {
      return table.table_name;
    });
    return tables;
  }

  async _getSchema(table) {
    var column, i, len, ref, result, schema, type;
    result = (await this._pool.query("SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name=$1", [table]));
    schema = {};
    ref = result.rows;
    for (i = 0, len = ref.length; i < len; i++) {
      column = ref[i];
      type = column.data_type === 'character varying' ? new types.String(column.character_maximum_length) : column.data_type === 'double precision' ? new types.Number() : column.data_type === 'boolean' ? new types.Boolean() : column.data_type === 'integer' ? new types.Integer() : column.data_type === 'USER-DEFINED' && column.udt_schema === 'public' && column.udt_name === 'geometry' ? new types.GeoPoint() : column.data_type === 'timestamp without time zone' ? new types.Date() : column.data_type === 'json' ? new types.Object() : column.data_type === 'text' ? new types.Text() : void 0;
      schema[column.column_name] = {
        type: type,
        required: column.is_nullable === 'NO'
      };
    }
    return schema;
  }

  async _getIndexes() {
    var i, indexes, indexes_of_table, len, name, name1, ref, result, row;
    // see http://stackoverflow.com/a/2213199/3239514
    result = (await this._pool.query("SELECT t.relname AS table_name, i.relname AS index_name, a.attname AS column_name FROM pg_class t, pg_class i, pg_index ix, pg_attribute a WHERE t.oid = ix.indrelid AND i.oid = ix.indexrelid AND a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)"));
    indexes = {};
    ref = result.rows;
    for (i = 0, len = ref.length; i < len; i++) {
      row = ref[i];
      indexes_of_table = indexes[name = row.table_name] || (indexes[name] = {});
      (indexes_of_table[name1 = row.index_name] || (indexes_of_table[name1] = {}))[row.column_name] = 1;
    }
    return indexes;
  }

  async _getForeignKeys() {
    var foreign_keys, foreign_keys_of_table, i, len, name, ref, result, row;
    // see http://stackoverflow.com/a/1152321/3239514
    result = (await this._pool.query("SELECT tc.table_name AS table_name, kcu.column_name AS column_name, ccu.table_name AS referenced_table_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name WHERE constraint_type = 'FOREIGN KEY'"));
    foreign_keys = {};
    ref = result.rows;
    for (i = 0, len = ref.length; i < len; i++) {
      row = ref[i];
      foreign_keys_of_table = foreign_keys[name = row.table_name] || (foreign_keys[name] = {});
      foreign_keys_of_table[row.column_name] = row.referenced_table_name;
    }
    return foreign_keys;
  }

  //# @override AdapterBase::getSchemas
  async getSchemas() {
    var foreign_keys, i, indexes, len, table, table_schemas, tables;
    tables = (await this._getTables());
    table_schemas = {};
    for (i = 0, len = tables.length; i < len; i++) {
      table = tables[i];
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
    sql.push('id SERIAL PRIMARY KEY');
    ref = model_class._schema;
    for (column in ref) {
      property = ref[column];
      column_sql = _propertyToSQL(property);
      if (column_sql) {
        sql.push(`"${property._dbname}" ${column_sql}`);
      }
    }
    sql = `CREATE TABLE "${tableName}" ( ${sql.join(',')} )`;
    try {
      await this._pool.query(sql);
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
  }

  //# @override AdapterBase::addColumn
  async addColumn(model, column_property) {
    var error, model_class, sql, tableName;
    model_class = this._connection.models[model];
    tableName = model_class.tableName;
    sql = `ALTER TABLE "${tableName}" ADD COLUMN "${column_property._dbname}" ${_propertyToSQL(column_property)}`;
    try {
      await this._pool.query(sql);
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
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
      columns.push(`"${column}" ${(order === -1 ? 'DESC' : 'ASC')}`);
    }
    unique = index.options.unique ? 'UNIQUE ' : '';
    sql = `CREATE ${unique}INDEX "${index.options.name}" ON "${tableName}" (${columns.join(',')})`;
    try {
      await this._pool.query(sql);
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
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
    sql = `ALTER TABLE "${tableName}" ADD FOREIGN KEY ("${column}") REFERENCES "${references.tableName}"(id) ON DELETE ${action}`;
    try {
      await this._pool.query(sql);
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
      await this._pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
  }

  _getModelID(data) {
    return Number(data.id);
  }

  valueToModel(value, property) {
    return value;
  }

  _buildSelect(model_class, select) {
    var escape_ch, schema;
    if (!select) {
      select = Object.keys(model_class._schema);
    }
    if (select.length > 0) {
      schema = model_class._schema;
      escape_ch = this._escape_ch;
      select = select.map(function(column) {
        var property;
        property = schema[column];
        column = escape_ch + schema[column]._dbname + escape_ch;
        if (property.type_class === types.GeoPoint) {
          return `ARRAY[ST_X(${column}), ST_Y(${column})] AS ${column}`;
        } else {
          return column;
        }
      });
      return 'id,' + select.join(',');
    } else {
      return 'id';
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
        fields.push(`"${dbname}"`);
        return places.push(`ST_Point($${values.length - 1}, $${values.length})`);
      } else {
        return fields.push(`"${dbname}"=ST_Point($${values.length - 1}, $${values.length})`);
      }
    } else if ((value != null ? value.$inc : void 0) != null) {
      values.push(value.$inc);
      return fields.push(`"${dbname}"="${dbname}"+$${values.length}`);
    } else {
      values.push(value);
      if (insert) {
        fields.push(`"${dbname}"`);
        return places.push('$' + values.length);
      } else {
        return fields.push(`"${dbname}"=$${values.length}`);
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
    var error, fields, places, result, rows, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    [fields, places] = this._buildUpdateSet(model, data, values, true);
    sql = `INSERT INTO "${tableName}" (${fields}) VALUES (${places}) RETURNING id`;
    try {
      result = (await this._pool.query(sql, values));
    } catch (error1) {
      error = error1;
      throw _processSaveError(tableName, error);
    }
    rows = result != null ? result.rows : void 0;
    if ((rows != null ? rows.length : void 0) === 1 && (rows[0].id != null)) {
      return rows[0].id;
    } else {
      throw new Error('unexpected rows');
    }
  }

  //# @override AdapterBase::createBulk
  async createBulk(model, data) {
    var error, fields, ids, places, result, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    fields = void 0;
    places = [];
    data.forEach((item) => {
      var places_sub;
      [fields, places_sub] = this._buildUpdateSet(model, item, values, true);
      return places.push('(' + places_sub + ')');
    });
    sql = `INSERT INTO "${tableName}" (${fields}) VALUES ${places.join(',')} RETURNING id`;
    try {
      result = (await this._pool.query(sql, values));
    } catch (error1) {
      error = error1;
      throw _processSaveError(tableName, error);
    }
    ids = result != null ? result.rows.map(function(row) {
      return row.id;
    }) : void 0;
    if (ids.length === data.length) {
      return ids;
    } else {
      throw new Error('unexpected rows');
    }
  }

  //# @override AdapterBase::update
  async update(model, data) {
    var error, fields, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    [fields] = this._buildUpdateSet(model, data, values);
    values.push(data.id);
    sql = `UPDATE "${tableName}" SET ${fields} WHERE id=$${values.length}`;
    try {
      await this._pool.query(sql, values);
    } catch (error1) {
      error = error1;
      throw _processSaveError(tableName, error);
    }
  }

  //# @override AdapterBase::updatePartial
  async updatePartial(model, data, conditions, options) {
    var error, fields, result, sql, tableName, values;
    tableName = this._connection.models[model].tableName;
    values = [];
    [fields] = this._buildPartialUpdateSet(model, data, values);
    sql = `UPDATE "${tableName}" SET ${fields}`;
    if (conditions.length > 0) {
      try {
        sql += ' WHERE ' + this._buildWhere(this._connection.models[model]._schema, conditions, values);
      } catch (error1) {
        e = error1;
        return callback(e);
      }
    }
    try {
      result = (await this._pool.query(sql, values));
    } catch (error1) {
      error = error1;
      throw _processSaveError(tableName, error);
    }
    return result.rowCount;
  }

  //# @override AdapterBase::findById
  async findById(model, id, options) {
    var error, result, rows, select, sql, tableName;
    select = this._buildSelect(this._connection.models[model], options.select);
    tableName = this._connection.models[model].tableName;
    sql = `SELECT ${select} FROM "${tableName}" WHERE id=$1 LIMIT 1`;
    if (options.explain) {
      return (await this._pool.query(`EXPLAIN ${sql}`, [id]));
    }
    try {
      result = (await this._pool.query(sql, [id]));
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
    rows = result != null ? result.rows : void 0;
    if ((rows != null ? rows.length : void 0) === 1) {
      return this._convertToModelInstance(model, rows[0], options);
    } else if ((rows != null ? rows.length : void 0) > 1) {
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
      order_by = `"${field}_distance"`;
      location = options.near[field];
      select += `,ST_Distance("${field}",ST_Point(${location[0]},${location[1]})) AS "${field}_distance"`;
    }
    params = [];
    tableName = this._connection.models[model].tableName;
    sql = `SELECT ${select} FROM "${tableName}"`;
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
        return `"${column}" ${order}`;
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
      sql += ' LIMIT ALL OFFSET ' + options.skip;
    }
    //console.log sql, params
    return [sql, params];
  }

  //# @override AdapterBase::find
  async find(model, conditions, options) {
    var error, params, result, rows, sql;
    [sql, params] = this._buildSqlForFind(model, conditions, options);
    if (options.explain) {
      return (await this._pool.query(`EXPLAIN ${sql}`, params));
    }
    try {
      result = (await this._pool.query(sql, params));
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
    rows = result != null ? result.rows : void 0;
    if (options.group_fields) {
      return rows.map((record) => {
        return this._convertToGroupInstance(model, record, options.group_by, options.group_fields);
      });
    } else {
      return rows.map((record) => {
        return this._convertToModelInstance(model, record, options);
      });
    }
  }

  //# @override AdapterBase::stream
  stream(model, conditions, options) {
    var params, readable, sql, transformer;
    if (!QueryStream) {
      console.log('Install pg-query-stream module to use stream');
      process.exit(1);
    }
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
    this._pool.connect().then(function(client) {
      return client.query(new QueryStream(sql, params)).on('end', function() {
        return client.release();
      }).on('error', function(error) {
        return transformer.emit('error', error);
      }).pipe(transformer);
    });
    return transformer;
  }

  //# @override AdapterBase::count
  async count(model, conditions, options) {
    var error, params, result, rows, sql, tableName;
    params = [];
    tableName = this._connection.models[model].tableName;
    sql = `SELECT COUNT(*) AS count FROM "${tableName}"`;
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
      result = (await this._pool.query(sql, params));
    } catch (error1) {
      error = error1;
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
    rows = result != null ? result.rows : void 0;
    if ((rows != null ? rows.length : void 0) !== 1) {
      throw new Error('unknown error');
    }
    return Number(rows[0].count);
  }

  //# @override AdapterBase::delete
  async delete(model, conditions) {
    var error, params, result, sql, tableName;
    params = [];
    tableName = this._connection.models[model].tableName;
    sql = `DELETE FROM "${tableName}"`;
    if (conditions.length > 0) {
      sql += ' WHERE ' + this._buildWhere(this._connection.models[model]._schema, conditions, params);
    }
    try {
      //console.log sql, params
      result = (await this._pool.query(sql, params));
    } catch (error1) {
      error = error1;
      if (error.code === '23503') {
        throw new Error('rejected');
      }
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
    if (result == null) {
      throw PostgreSQLAdapter.wrapError('unknown error', error);
    }
    return result.rowCount;
  }

  /**
   * Connects to the database
   */
  public async connect(settings: IAdapterSettingsPostgreSQL) {
    var client, error, pool;
    // connect
    pool = new pg.Pool({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      database: settings.database
    });
    try {
      client = (await pool.connect());
      client.release();
      this._pool = pool;
    } catch (error1) {
      error = error1;
      if (error.code === '3D000') {
        throw new Error('database does not exist');
      }
      throw PostgreSQLAdapter.wrapError('failed to connect', error);
    }
  }

  public close() {
    this._pool.end();
    return this._pool = null;
  }

  /**
   * Exposes pg module's query method
   */
  public query() {
    return this._pool.query.apply(this._pool, arguments);
  }
}

export default (connection) => {
  return new PostgreSQLAdapter(connection);
};