// System skipSeat handler (design §5.10). Runs only after the system precedence checks pass; rejects with
// skip_not_allowed until the absence track lands.
import type { SystemHandler } from './types';

export const skipSeat: SystemHandler = () => ({ ok: false, reason: 'skip_not_allowed' });
