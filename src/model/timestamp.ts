/**
 * Timestamps
 * @namespace model
 */
class ModelTimestamp {
  //#
  // Adds 'created_at' and 'updated_at' fields to records
  static timestamps() {
    this.column('created_at', Date);
    this.column('updated_at', Date);
    this.beforeCreate(function() {
      var d;
      d = new Date();
      return this.created_at = this.updated_at = d;
    });
    return this.beforeUpdate(function() {
      var d;
      d = new Date();
      return this.updated_at = d;
    });
  }
}

export { ModelTimestamp };