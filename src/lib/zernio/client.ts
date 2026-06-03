export { classifyAndParse } from './client/error-classifier';
export { request, createZernioTransport } from './client/transport';

import { createLocationClient } from './client/locations';
import { createProfileClient } from './client/profiles';
import { createReplyClient } from './client/replies';
import { createZernioTransport } from './client/transport';

const transport = createZernioTransport();

export const zernioClient = {
  ...createProfileClient(transport),
  ...createLocationClient(transport),
  ...createReplyClient(transport),
};
