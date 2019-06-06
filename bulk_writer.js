const Promise = require('promise');
const debug = require('debug')('winston:elasticsearch');
const retry = require('retry');

const BulkWriter = function BulkWriter(client, options) {
  this.client = client;
  this.options = options;
  this.interval = options.interval || 5000;
  this.waitForActiveShards = options.waitForActiveShards;
  this.pipeline = options.pipeline;

  this.bulk = []; // bulk to be flushed
  this.running = false;
  this.timer = false;
  debug('created', this);
};

BulkWriter.prototype.start = function start() {
  this.checkEsConnection();
  this.running = true;
  this.tick();
  debug('started');
};

BulkWriter.prototype.stop = function stop() {
  this.running = false;
  if (!this.timer) { return; }
  clearTimeout(this.timer);
  this.timer = null;
  debug('stopped');
};

BulkWriter.prototype.schedule = function schedule() {
  const thiz = this;
  this.timer = setTimeout(() => {
    thiz.tick();
  }, this.interval);
};

BulkWriter.prototype.tick = function tick() {
  debug('tick');
  const thiz = this;
  if (!this.running) { return; }
  this.flush()
    .then(() => {
      // Emulate finally with last .then()
    })
    .then(() => { // finally()
      thiz.schedule();
    });
};

BulkWriter.prototype.flush = function flush() {
  // write bulk to elasticsearch
  const thiz = this;
  if (this.bulk.length === 0) {
    debug('nothing to flush');
    return new Promise((resolve) => {
      return resolve();
    });
  }
  const bulk = this.bulk.concat();
  this.bulk = [];
  debug('going to write', bulk);
  return this.client.bulk({
    body: bulk,
    waitForActiveShards: this.waitForActiveShards,
    timeout: this.interval + 'ms',
    type: this.type
  }).then((res) => {
    if (res.errors && res.items) {
      res.items.forEach((item) => {
        if (item.index && item.index.error) {
          // eslint-disable-next-line no-console
          console.error('Elasticsearch index error', item.index.error);
        }
      });
    }
  }).catch((e) => { // prevent [DEP0018] DeprecationWarning
    // rollback this.bulk array
    thiz.bulk = bulk.concat(thiz.bulk);
    // eslint-disable-next-line no-console
    console.error(e);
    debug('error occrrued', e);
    this.stop();
    this.checkEsConnection();
  });
};

BulkWriter.prototype.append = function append(index, type, doc) {
  this.bulk.push({
    index: {
      _index: index, _type: type, pipeline: this.pipeline
    }
  });
  this.bulk.push(doc);
};

BulkWriter.prototype.checkEsConnection = function checkEsConnection() {
  const thiz = this;
  thiz.esConnection = false;

  const operation = retry.operation({
    forever: true,
    retries: 1,
    factor: 1,
    minTimeout: 1 * 1000,
    maxTimeout: 60 * 1000,
    randomize: false
  });
  return new Promise((fulfill, reject) => {
    operation.attempt((currentAttempt) => {
      debug('checking for connection');
      thiz.client.ping().then(
        (res) => {
          thiz.esConnection = true;
          fulfill(true);
          debug('starting bulk writer');
          thiz.running = true;
          thiz.tick();
        },
        (err) => {
          debug('checking for connection');
          if (operation.retry(err)) {
            return;
          }
          // thiz.esConnection = false;
          reject(new Error('Cannot connect to ES'));
        }
      );
    });
  });
};

module.exports = BulkWriter;
