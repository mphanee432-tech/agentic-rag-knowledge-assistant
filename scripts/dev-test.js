/* eslint-disable @typescript-eslint/no-require-imports */
process.env.APP_ENV = 'test';
process.argv = [process.argv[0], 'next', 'dev', ...process.argv.slice(2)];
require('../node_modules/next/dist/bin/next');

