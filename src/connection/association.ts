import * as _ from 'lodash';
import * as inflector from '../util/inflector';
import * as types from '../types';

/**
 * Makes association between two models
 * @namespace connection
 */
class ConnectionAssociation {
  //#
  // Applies pending associations
  // @param {Connection} connection
  // @param {Array<Object>} associations
  // @param {String} associations.type 'hasMany' or 'belongsTo'
  // @private
  public _applyAssociations() {
    var i, item, len, models, options, ref, ref1, ref2, target_model, this_model;
    ref = this._pending_associations;
    for (i = 0, len = ref.length; i < len; i++) {
      item = ref[i];
      this_model = item.this_model;
      options = item.options;
      if (typeof item.target_model_or_column === 'string') {
        if ((ref1 = item.options) != null ? ref1.connection : void 0) {
          models = item.options.connection.models;
        } else {
          models = this.models;
        }
        if ((ref2 = item.options) != null ? ref2.type : void 0) {
          target_model = item.options.type;
          options.as = item.target_model_or_column;
        } else if (item.type === 'belongsTo' || item.type === 'hasOne') {
          target_model = inflector.camelize(item.target_model_or_column);
        } else {
          target_model = inflector.classify(item.target_model_or_column);
        }
        if (!models[target_model]) {
          throw new Error(`model ${target_model} does not exist`);
        }
        target_model = models[target_model];
      } else {
        target_model = item.target_model_or_column;
      }
      this['_' + item.type](this_model, target_model, options);
    }
    return this._pending_associations = [];
  }

  //#
  // Adds an association
  // @param {Object} association
  // @param {String} association.type 'hasMany' or 'belongsTo'
  // @param {Class<Model>} association.this_model
  // @param {Class<Model>|String} association.target_model_or_column
  // @param {Object} [association.options]
  // @param {String} [association.options.type]
  // @param {String} [association.options.as]
  // @param {String} [association.options.foreign_key]
  // @see Model.hasMany
  // @see Model.belongsTo
  public addAssociation(association) {
    this._pending_associations.push(association);
    return this._schema_changed = true;
  }

  //#
  // Returns inconsistent records against associations
  // @return {Object} Hash of model name to Array of RecordIDs
  // @promise
  public async getInconsistencies() {
    var promises, result;
    await this._checkSchemaApplied();
    result = {};
    promises = Object.keys(this.models).map(async (model) => {
      var ids, integrities, modelClass, records, sub_promises;
      modelClass = this.models[model];
      integrities = modelClass._integrities.filter(function(integrity) {
        return integrity.type.substr(0, 7) === 'parent_';
      });
      if (integrities.length > 0) {
        records = (await modelClass.select(''));
        ids = records.map(function(record) {
          return record.id;
        });
        sub_promises = integrities.map(async (integrity) => {
          var array, name, property, query;
          query = integrity.child.select('');
          query.where(_.zipObject([integrity.column], [
            {
              $not: {
                $in: ids
              }
            }
          ]));
          property = integrity.child._schema[integrity.column];
          if (!property.required) {
            query.where(_.zipObject([integrity.column], [
              {
                $not: null
              }
            ]));
          }
          records = (await query.exec());
          if (records.length > 0) {
            array = result[name = integrity.child._name] || (result[name] = []);
            [].push.apply(array, records.map(function(record) {
              return record.id;
            }));
            return _.uniq(array);
          }
        });
        return (await Promise.all(sub_promises));
      }
    });
    await Promise.all(promises);
    return result;
  }
  //#
  // Fetches associated records
  // @param {Model|Array<Model>} records
  // @param {String} column
  // @param {String} [select]
  // @param {Object} [options]
  // @promise
  public async fetchAssociated(records, column, select, options) {
    var association, record, ref, ref1;
    if ((select != null) && typeof select === 'object') {
      options = select;
      select = null;
    } else if (options == null) {
      options = {};
    }
    await this._checkSchemaApplied();
    record = Array.isArray(records) ? records[0] : records;
    if (!record) {
      return;
    }
    if (options.target_model) {
      association = {
        type: options.type || 'belongsTo',
        target_model: options.target_model,
        foreign_key: options.foreign_key
      };
    } else if (options.model) {
      association = (ref = options.model._associations) != null ? ref[column] : void 0;
    } else {
      association = (ref1 = record.constructor._associations) != null ? ref1[column] : void 0;
    }
    if (!association) {
      throw new Error(`unknown column '${column}'`);
    }
    if (association.type === 'belongsTo') {
      return (await this._fetchAssociatedBelongsTo(records, association.target_model, column, select, options));
    } else if (association.type === 'hasMany') {
      return (await this._fetchAssociatedHasMany(records, association.target_model, association.foreign_key, column, select, options));
    } else {
      throw new Error(`unknown column '${column}'`);
    }
  }

  //#
  // Adds a has-many association
  // @param {Class<Model>} this_model
  // @param {Class<Model>} target_model
  // @param {Object} [options]
  // @param {String} [options.as]
  // @param {String} [options.foreign_key]
  // @param {String} [options.integrity='ignore'] 'ignore', 'nullify'
  // @private
  private _hasMany(this_model, target_model, options) {
    var column, columnCache, columnGetter, foreign_key, integrity;
    if (options != null ? options.foreign_key : void 0) {
      foreign_key = options.foreign_key;
    } else if (options != null ? options.as : void 0) {
      foreign_key = options.as + '_id';
    } else {
      foreign_key = inflector.foreign_key(this_model._name);
    }
    target_model.column(foreign_key, {
      type: types.RecordID,
      connection: this_model._connection
    });
    integrity = (options != null ? options.integrity : void 0) || 'ignore';
    target_model._integrities.push({
      type: 'child_' + integrity,
      column: foreign_key,
      parent: this_model
    });
    this_model._integrities.push({
      type: 'parent_' + integrity,
      column: foreign_key,
      child: target_model
    });
    column = (options != null ? options.as : void 0) || inflector.tableize(target_model._name);
    columnCache = '__cache_' + column;
    columnGetter = '__getter_' + column;
    this_model._associations[column] = {
      type: 'hasMany',
      target_model: target_model,
      foreign_key: foreign_key
    };
    return Object.defineProperty(this_model.prototype, column, {
      get: function() {
        var getter;
        // getter must be created per instance due to __scope
        if (!this.hasOwnProperty(columnGetter)) {
          getter = async function(reload) {
            var records, self;
            // @ is getter.__scope in normal case (this_model_instance.target_model_name()),
            // but use getter.__scope for safety
            self = getter.__scope;
            if ((!self[columnCache] || reload) && self.id) {
              records = (await target_model.where(_.zipObject([foreign_key], [self.id])));
              self[columnCache] = records;
              return records;
            } else {
              return self[columnCache] || [];
            }
          };
          getter.build = function(data) {
            var new_object, self;
            // @ is getter, so use getter.__scope instead
            self = getter.__scope;
            new_object = new target_model(data);
            new_object[foreign_key] = self.id;
            if (!self[columnCache]) {
              self[columnCache] = [];
            }
            self[columnCache].push(new_object);
            return new_object;
          };
          getter.__scope = this;
          Object.defineProperty(this, columnCache, {
            value: null,
            writable: true
          });
          Object.defineProperty(this, columnGetter, {
            value: getter
          });
        }
        return this[columnGetter];
      }
    });
  }

  //#
  // Adds a has-one association
  // @param {Class<Model>} this_model
  // @param {Class<Model>} target_model
  // @param {Object} [options]
  // @private
  private _hasOne(this_model, target_model, options) {
    var column, columnCache, columnGetter, foreign_key, integrity;
    if (options != null ? options.foreign_key : void 0) {
      foreign_key = options.foreign_key;
    } else if (options != null ? options.as : void 0) {
      foreign_key = options.as + '_id';
    } else {
      foreign_key = inflector.foreign_key(this_model._name);
    }
    target_model.column(foreign_key, {
      type: types.RecordID,
      connection: this_model._connection
    });
    integrity = (options != null ? options.integrity : void 0) || 'ignore';
    target_model._integrities.push({
      type: 'child_' + integrity,
      column: foreign_key,
      parent: this_model
    });
    this_model._integrities.push({
      type: 'parent_' + integrity,
      column: foreign_key,
      child: target_model
    });
    column = (options != null ? options.as : void 0) || inflector.underscore(target_model._name);
    columnCache = '__cache_' + column;
    columnGetter = '__getter_' + column;
    this_model._associations[column] = {
      type: 'hasOne',
      target_model: target_model
    };
    return Object.defineProperty(this_model.prototype, column, {
      get: function() {
        var getter;
        // getter must be created per instance due to __scope
        if (!this.hasOwnProperty(columnGetter)) {
          getter = async function(reload) {
            var record, records, self;
            // @ is getter.__scope in normal case (this_model_instance.target_model_name()),
            // but use getter.__scope for safety
            self = getter.__scope;
            if ((!self[columnCache] || reload) && self.id) {
              records = (await target_model.where(_.zipObject([foreign_key], [self.id])));
              if (records.length > 1) {
                throw new Error('integrity error');
              }
              record = records.length === 0 ? null : records[0];
              self[columnCache] = record;
              return record;
            } else {
              return self[columnCache];
            }
          };
          getter.__scope = this;
          Object.defineProperty(this, columnCache, {
            value: null,
            writable: true
          });
          Object.defineProperty(this, columnGetter, {
            value: getter
          });
        }
        return this[columnGetter];
      }
    });
  }

  //#
  // Adds a belongs-to association
  // @param {Class<Model>} this_model
  // @param {Class<Model>} target_model
  // @param {Object} [options]
  // @param {String} [options.as]
  // @param {String} [options.foreign_key]
  // @private
  private _belongsTo(this_model, target_model, options) {
    var column, columnCache, columnGetter, foreign_key;
    if (options != null ? options.foreign_key : void 0) {
      foreign_key = options.foreign_key;
    } else if (options != null ? options.as : void 0) {
      foreign_key = options.as + '_id';
    } else {
      foreign_key = inflector.foreign_key(target_model._name);
    }
    this_model.column(foreign_key, {
      type: types.RecordID,
      connection: target_model._connection,
      required: options != null ? options.required : void 0
    });
    column = (options != null ? options.as : void 0) || inflector.underscore(target_model._name);
    columnCache = '__cache_' + column;
    columnGetter = '__getter_' + column;
    this_model._associations[column] = {
      type: 'belongsTo',
      target_model: target_model
    };
    return Object.defineProperty(this_model.prototype, column, {
      get: function() {
        var getter;
        // getter must be created per instance due to __scope
        if (!this.hasOwnProperty(columnGetter)) {
          getter = async function(reload) {
            var record, self;
            // @ is getter.__scope in normal case (this_model_instance.target_model_name()),
            // but use getter.__scope for safety
            self = getter.__scope;
            if ((!self[columnCache] || reload) && self[foreign_key]) {
              record = (await target_model.find(self[foreign_key]));
              self[columnCache] = record;
              return record;
            } else {
              return self[columnCache];
            }
          };
          getter.__scope = this;
          Object.defineProperty(this, columnCache, {
            value: null,
            writable: true
          });
          Object.defineProperty(this, columnGetter, {
            value: getter
          });
        }
        return this[columnGetter];
      }
    });
  }

  private async _fetchAssociatedBelongsTo(records, target_model, column, select, options) {
    var error, id, id_column, id_to_record_map, ids, query, sub_record, sub_records;
    id_column = column + '_id';
    if (Array.isArray(records)) {
      id_to_record_map = {};
      records.forEach(function(record) {
        var id;
        id = record[id_column];
        if (id) {
          (id_to_record_map[id] || (id_to_record_map[id] = [])).push(record);
        }
      });
      ids = Object.keys(id_to_record_map);
      query = target_model.where({
        id: ids
      });
      if (select) {
        query.select(select);
      }
      if (options.lean) {
        query.lean();
      }
      try {
        sub_records = (await query.exec());
        sub_records.forEach(function(sub_record) {
          return id_to_record_map[sub_record.id].forEach(function(record) {
            if (options.lean) {
              return record[column] = sub_record;
            } else {
              return Object.defineProperty(record, column, {
                enumerable: true,
                value: sub_record
              });
            }
          });
        });
        records.forEach(function(record) {
          if (!record.hasOwnProperty(column)) {
            if (options.lean) {
              record[column] = null;
            } else {
              Object.defineProperty(record, column, {
                enumerable: true,
                value: null
              });
            }
          }
        });
      } catch (error1) {

      }
    } else {
      id = records[id_column];
      if (id) {
        query = target_model.find(id);
        if (select) {
          query.select(select);
        }
        if (options.lean) {
          query.lean();
        }
        try {
          sub_record = (await query.exec());
          if (options.lean) {
            records[column] = sub_record;
          } else {
            Object.defineProperty(records, column, {
              enumerable: true,
              value: sub_record
            });
          }
        } catch (error1) {
          error = error1;
          if (error && error.message !== 'not found') {
            throw error;
          }
          if (!records.hasOwnProperty(column)) {
            if (options.lean) {
              records[column] = null;
            } else {
              Object.defineProperty(records, column, {
                enumerable: true,
                value: null
              });
            }
          }
        }
      } else if (!records.hasOwnProperty(column)) {
        if (options.lean) {
          records[column] = null;
        } else {
          Object.defineProperty(records, column, {
            enumerable: true,
            value: null
          });
        }
      }
    }
  }

  private async _fetchAssociatedHasMany(records, target_model, foreign_key, column, select, options) {
    var ids, query, sub_records;
    if (Array.isArray(records)) {
      ids = records.map(function(record) {
        if (options.lean) {
          record[column] = [];
        } else {
          Object.defineProperty(record, column, {
            enumerable: true,
            value: []
          });
        }
        return record.id;
      });
      query = target_model.where(_.zipObject([foreign_key], [
        {
          $in: ids
        }
      ]));
      if (select) {
        query.select(select + ' ' + foreign_key);
      }
      if (options.lean) {
        query.lean();
      }
      try {
        sub_records = (await query.exec());
        sub_records.forEach(function(sub_record) {
          return records.forEach(function(record) {
            if (record.id === sub_record[foreign_key]) {
              return record[column].push(sub_record);
            }
          });
        });
      } catch (error1) {

      }
    } else {
      if (options.lean) {
        records[column] = [];
      } else {
        Object.defineProperty(records, column, {
          enumerable: true,
          value: []
        });
      }
      query = target_model.where(_.zipObject([foreign_key], [records.id]));
      if (select) {
        query.select(select + ' ' + foreign_key);
      }
      if (options.lean) {
        query.lean();
      }
      try {
        sub_records = (await query.exec());
        sub_records.forEach(function(sub_record) {
          return records[column].push(sub_record);
        });
      } catch (error1) {

      }
    }
  }

}

export { ConnectionAssociation };