import adapter from '@probot/adapter-github-actions';
import { robot } from './bot.js';
import './log.js';

adapter.run(robot);
