import { runWP5LiveDemo } from './wp5_live_demo';

runWP5LiveDemo()
  .then(({ allPass }) => {
    if (!allPass) {
      console.error('WP5 Live Demo encountered failures.');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('WP5 Live Demo Failed:', err);
    process.exit(1);
  });
