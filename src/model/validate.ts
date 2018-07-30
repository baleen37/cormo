import * as types from '../types';
import * as util from '../util';

/**
 * Model validate
 * @namespace model
 */
class ModelValidate {
  static _validateType(column, type_class, value) {
    switch (type_class) {
      case types.Number:
        value = Number(value);
        if (isNaN(value)) {
          throw `'${column}' is not a number`;
        }
        break;
      case types.Boolean:
        if (typeof value !== 'boolean') {
          throw `'${column}' is not a boolean`;
        }
        break;
      case types.Integer:
        value = Number(value);
        // value>>0 checkes integer and 32bit
        if (isNaN(value) || (value >> 0) !== value) {
          throw `'${column}' is not an integer`;
        }
        break;
      case types.GeoPoint:
        if (!(Array.isArray(value) && value.length === 2)) {
          throw `'${column}' is not a geo point`;
        } else {
          value[0] = Number(value[0]);
          value[1] = Number(value[1]);
        }
        break;
      case types.Date:
        value = new Date(value);
        if (isNaN(value.getTime())) {
          throw `'${column}' is not a date`;
        }
    }
    return value;
  }

  static _validateColumn(data, column, property, for_update) {
    var error, i, j, last, len, obj, ref, v, value;
    [obj, last] = util.getLeafOfPath(data, property._parts, false);
    value = obj != null ? obj[last] : void 0;
    if (value != null) {
      if (property.array) {
        if (!Array.isArray(value)) {
          throw `'${column}' is not an array`;
        }
        try {
          for (i = j = 0, len = value.length; j < len; i = ++j) {
            v = value[i];
            value[i] = this._validateType(column, property.type_class, v);
          }
        } catch (error1) {
          error = error1;
          // TODO: detail message like 'array of types'
          throw `'${column}' is not an array`;
        }
      } else {
        if (value.$inc != null) {
          if (for_update) {
            if ((ref = property.type_class) === types.Number || ref === types.Integer) {
              obj[last] = {
                $inc: this._validateType(column, property.type_class, value.$inc)
              };
            } else {
              throw `'${column}' is not a number type`;
            }
          } else {
            throw '$inc is allowed only for update method';
          }
        } else {
          obj[last] = this._validateType(column, property.type_class, value);
        }
      }
    } else {
      if (property.required) {
        throw `'${column}' is required`;
      }
    }
  }

  //#
  // Validates data
  // @promise
  validate() {
    var column, ctor, error, errors, property, schema;
    this._runCallbacks('validate', 'before');
    errors = [];
    ctor = this.constructor;
    schema = ctor._schema;
    for (column in schema) {
      property = schema[column];
      try {
        ctor._validateColumn(this, column, property);
      } catch (error1) {
        error = error1;
        errors.push(error);
      }
    }
    this.constructor._validators.forEach((validator) => {
      var e, r;
      try {
        r = validator(this);
        if (r === false) {
          return errors.push('validation failed');
        } else if (typeof r === 'string') {
          return errors.push(r);
        }
      } catch (error1) {
        e = error1;
        return errors.push(e.message);
      }
    });
    if (errors.length > 0) {
      this._runCallbacks('validate', 'after');
      throw new Error(errors.join(','));
    } else {
      this._runCallbacks('validate', 'after');
    }
  }

  //#
  // Adds a validator

  // A validator must return false(boolean) or error message(string), or throw an Error exception if invalid
  // @param {Function} validator
  // @param {Model} validator.record
  static addValidator(validator) {
    this._checkConnection();
    this._validators.push(validator);
  }
}

export { ModelValidate };
