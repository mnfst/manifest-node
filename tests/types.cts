import sdk = require('manifest');
const initialize: () => void = () => sdk.manifest({ key: 'example' });
const finish: () => Promise<void> = () => sdk.flush();
void initialize; void finish;
