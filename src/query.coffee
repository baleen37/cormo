###
# Collects conditions to query
###
class DBQuery
  ###
  # Creates a query instance
  # @param {Class} model
  ###
  constructor: (model) ->
    @_model = model
    @_name = model._name
    @_adapter = model._connection._adapter
    @_conditions = []
 
  ###
  # Finds a record by id
  # @param {String} id
  # @return {DBQuery} this
  ###
  find: (id) ->
    @_id = id
    return @

  ###
  # Find records by condition
  # @param {Object} condition
  # @return {DBQuery} this
  ###
  where: (condition) ->
    if Array.isArray condition
      @_conditions.push.apply @_conditions, condition
    else
      @_conditions.push condition
    return @

  ###
  # Executes the query
  # @param {Function} callback
  # @param {Error} callback.error
  # @param {Array<DBModel>} callback.records
  # @return {DBQuery} this
  ###
  exec: (callback) ->
    if @_id and @_conditions.length is 0
      @_adapter.findById @_name, @_id, (error, record) ->
        return callback error if error
        callback null, [record]
      return
    if @_id
      @_conditions.push id: @_id
      delete @_id
    @_adapter.find @_name, @_conditions, callback

module.exports = DBQuery