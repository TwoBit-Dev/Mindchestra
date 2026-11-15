# Example Custom Adapter for Mindchestra

This example demonstrates how to build a minimal, contract-compliant agent adapter using `@mindchestra/adapter-sdk`.

## Files
- `src/echo-adapter.ts`: Demonstrates extending `BaseAgentAdapter`, implementing `probe()` and `run()`.
- `src/index.ts`: Public module exports.

## How to test conformance
```typescript
import { validateAdapterConformance } from '@mindchestra/adapter-sdk';
import { EchoCustomAdapter } from './src/echo-adapter.js';

const adapter = new EchoCustomAdapter();
const report = await validateAdapterConformance(adapter);
console.log('Passed:', report.passed);
```
