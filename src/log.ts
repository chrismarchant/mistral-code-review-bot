import log from 'loglevel';

const level = (process.env.LOG_LEVEL || 'info') as
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'silent';
log.setLevel(level);

export default log;
