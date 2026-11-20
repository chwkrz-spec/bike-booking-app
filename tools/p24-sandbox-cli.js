import { readFile } from 'node:fs/promises';
import { p24SandboxFromEnv } from './p24-sandbox.js';

const [action, inputFile] = process.argv.slice(2);
const actions = {
  register: (sandbox, input) => sandbox.register(input),
  verify: (sandbox, { payment, notification }) => sandbox.verify(payment, notification),
  transaction: (sandbox, { sessionId }) => sandbox.transaction(sessionId),
  dispatch: (sandbox, input) => sandbox.dispatch(input),
  dispatchInfo: (sandbox, { orderId }) => sandbox.dispatchInfo(orderId),
  refund: async (sandbox, input) => {
    await sandbox.refund(input);
    return { accepted: true, requestId: input.requestId };
  },
  refunds: (sandbox, { orderId }) => sandbox.refunds(orderId),
  balance: (sandbox, { merchantId }) => sandbox.balance(merchantId),
};

try {
  if (!inputFile || !Object.hasOwn(actions, action)) {
    throw new Error(`Usage: npm run p24:sandbox -- <${Object.keys(actions).join('|')}> <input.json>`);
  }
  const input = JSON.parse(await readFile(inputFile, 'utf-8'));
  console.log(JSON.stringify(await actions[action](p24SandboxFromEnv(), input), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
