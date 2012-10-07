try
  mysql = require 'mysql'
catch e
  console.log 'Install mysql module to use this adapter'
  process.exit 1

AdapterBase = require './base'
DBModel = require '../model'
tableize = require('../inflector').tableize
async = require 'async'

_typeToSQL = (property) ->
  switch property.type
    when DBModel.String then 'VARCHAR(255)'
    when DBModel.Number then 'DOUBLE'
    when DBModel.ForeignKey then 'BIGINT'

_propertyToSQL = (property) ->
  type = _typeToSQL property
  if type
    type += ' NULL'
    if property.unique
      type += ' UNIQUE'
    return type

_buildWhere = (conditions, params, conjunction='AND') ->
  if Array.isArray conditions
    subs = conditions.map (condition) -> _buildWhere condition, params
  else if typeof conditions is 'object'
    keys = Object.keys conditions
    if keys.length is 0
      return ''
    if keys.length is 1
      key = keys[0]
      if key.substr(0, 1) is '$'
        switch key
          when '$and'
            return _buildWhere conditions[key], params, 'AND'
          when '$or'
            return _buildWhere conditions[key], params, 'OR'
      else
        value = conditions[key]
        op = '='
        if typeof value is 'object' and (keys = Object.keys value).length is 1
          sub_key = keys[0]
          switch sub_key
            when '$gt'
              op = '>'
              value = value[sub_key]
            when '$lt'
              op = '<'
              value = value[sub_key]
            when '$gte'
              op = '>='
              value = value[sub_key]
            when '$lte'
              op = '<='
              value = value[sub_key]
            when '$include'
              op = ' LIKE '
              value = '%' + value[sub_key] + '%'
        params.push value
        return key + op + '?'
    else
      subs = keys.map (key) ->
        obj = {}
        obj[key] = conditions[key]
        _buildWhere obj, params
  else
    return ''
  return '(' + subs.join(' ' + conjunction + ' ') + ')'

###
# Adapter for MySQL
###
class MySQLAdapter extends AdapterBase
  ###
  # Creates a MySQL adapter
  # @param {mysql.Connection} client
  ###
  constructor: (connection, client) ->
    @_connection = connection
    @_client = client

  _query: (sql, data, callback) ->
    #console.log 'MySQLAdapter:', sql
    @_client.query sql, data, callback

  _createTable: (model, callback) ->
    table = tableize model
    sql = []
    sql.push 'id BIGINT NOT NULL AUTO_INCREMENT UNIQUE PRIMARY KEY'
    for field, property of @_connection.models[model]._schema
      field_sql = _propertyToSQL property
      if field_sql
        sql.push field + ' ' + field_sql
    sql = "CREATE TABLE #{table} ( #{sql.join ','} )"
    @_query sql, (error, result) ->
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      callback null

  _alterTable: (model, fields, callback) ->
    # TODO
    callback null

  _applySchema: (model, callback) ->
    table = tableize model
    @_query "SHOW FIELDS FROM #{table}", (error, fields) =>
      if error?.code is 'ER_NO_SUCH_TABLE'
        @_createTable model, callback
      else
        @_alterTable model, fields, callback

  ###
  # Creates or alters tables reflecting schemas
  # @param {Function} callback
  # @param {Error} callback.error
  # @see DBConnection.applySchemas
  ###
  applySchemas: (callback) ->
    async.forEach Object.keys(@_connection.models), (model, callback) =>
        @_applySchema model, callback
      , (error) ->
        callback error

  ###
  # Drops a model from the database
  # @param {String} model
  # @param {Function} callback
  # @param {Error} callback.error
  # @see DBModel.drop
  ###
  drop: (model, callback) ->
    table = tableize model
    @_query "DROP TABLE IF EXISTS #{table}", (error) ->
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      callback null

  ###
  # Creates a record
  # @param {String} model
  # @param {Object} data
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {String} callback.id
  ###
  create: (model, data, callback) ->
    table = tableize model
    @_query "INSERT INTO #{table} SET ?", data, (error, result) ->
      if error?.code is 'ER_DUP_ENTRY'
        key = error.message.match /for key '([^']*)'/
        return callback new Error('duplicated ' + key?[1])
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      if result?.insertId
        callback null, result.insertId
      else
        callback new Error 'unexpected result'

  ###
  # Updates a record
  # @param {String} model
  # @param {Object} data
  # @param {Function} callback
  # @param {Error} callback.error
  ###
  update: (model, data, callback) ->
    table = tableize model
    @_query "UPDATE #{table} SET ? WHERE id=?", [data, data.id], (error) ->
      if error?.code is 'ER_DUP_ENTRY'
        key = error.message.match /for key '([^']*)'/
        return callback new Error('duplicated ' + key?[1])
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      callback null

  _convertToModelInstance: (model, data) ->
    modelClass = @_connection.models[model]
    record = new modelClass()
    Object.defineProperty record, 'id', configurable: false, enumerable: true, writable: false, value: Number(data.id)
    for field, property of modelClass._schema
      if property.type is DBModel.ForeignKey
        record[field] = Number(data[field])
      else
        record[field] = data[field]
    return record

  ###
  # Finds a record by id
  # @param {String} model
  # @param {String} id
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {DBModel} callback.record
  # @throws Error('not found')
  ###
  findById: (model, id, callback) ->
    table = tableize model
    @_query "SELECT * FROM #{table} WHERE id=? LIMIT 1", id, (error, result) =>
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      if result?.length is 1
        callback null, @_convertToModelInstance model, result[0]
      else if result?.length > 1
        callback new Error 'unknown error'
      else
        callback new Error 'not found'

  ###
  # Finds records
  # @param {String} model
  # @param {Object} conditions
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {Array<DBModel>} callback.records
  ###
  find: (model, conditions, callback) ->
    params = []
    sql = "SELECT * FROM #{tableize model}"
    if conditions.length > 0
      sql += ' WHERE ' + _buildWhere conditions, params
    #console.log sql, params
    @_query sql, params, (error, result) =>
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      callback null, result.map (instance) => @_convertToModelInstance model, instance

  ###
  # Counts records
  # @param {String} model
  # @param {Object} conditions
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {Number} callback.count
  ###
  count: (model, conditions, callback) ->
    params = []
    sql = "SELECT COUNT(*) AS count FROM #{tableize model}"
    if conditions.length > 0
      sql += ' WHERE ' + _buildWhere conditions, params
    #console.log sql, params
    @_query sql, params, (error, result) =>
      return callback MySQLAdapter.wrapError 'unknown error', error if error
      return callback error 'unknown error' if result?.length isnt 1
      callback null, Number(result[0].count)

  ###
  # Deletes records from the database
  # @param {String} model
  # @param {Object} conditions
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {Number} callback.count
  ###
  delete: (model, conditions, callback) ->
    params = []
    sql = "DELETE FROM #{tableize model}"
    if conditions.length > 0
      sql += ' WHERE ' + _buildWhere conditions, params
    #console.log sql, params
    @_query sql, params, (error, result) ->
      return callback MySQLAdapter.wrapError 'unknown error', error if error or not result?
      callback null, result.affectedRows

  ###
  # Creates a MySQL adapter
  # @param {Connection} connection
  # @param {Object} settings
  # @param {String} [settings.host]
  # @param {Number} [settings.port]
  # @param {String} [settings.user]
  # @param {String} [settings.password]
  # @param {String} settings.database
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {MySQLAdapter} callback.adapter
  ###
  @createAdapter: (connection, settings, callback) ->
    # connect
    client = mysql.createConnection
      host: settings.host
      port: settings.port
      user: settings.user
      password: settings.password
    client.connect (error) ->
      return callback MySQLAdapter.wrapError 'failed to connect', error if error

      adapter = new MySQLAdapter connection, client

      # select database
      client.query "USE `#{settings.database}`", (error) ->
        return callback null, adapter if not error

        # create one if not exist
        if error.code is 'ER_BAD_DB_ERROR'
          client.query "CREATE DATABASE `#{settings.database}`", (error) ->
            return callback MySQLAdapter.wrapError 'unknown error', error if error
            return callback null, adapter
        else
          msg = if error.code is 'ER_DBACCESS_DENIED_ERROR' then "no access right to the database '#{settings.database}'" else 'unknown error'
          callback MySQLAdapter.wrapError msg, error

module.exports = MySQLAdapter.createAdapter
