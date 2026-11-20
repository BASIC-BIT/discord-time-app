import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.daily('prune parsing usage', {hourUTC:0,minuteUTC:30}, internal.usage.prune, {});
export default crons;
