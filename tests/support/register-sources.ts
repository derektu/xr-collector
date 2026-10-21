import { registerSources } from '../../src/plugins/index.js';

// Every test runs with the product's source types registered, as the composition roots register them.
registerSources();
