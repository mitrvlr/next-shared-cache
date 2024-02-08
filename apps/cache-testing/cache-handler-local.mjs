import { IncrementalCache } from '@neshca/cache-handler';
import createLruCache from '@neshca/cache-handler/local-lru';

IncrementalCache.onCreation(async () => {
    const localCache = createLruCache();

    return {
        cache: localCache,
    };
});

export default IncrementalCache;
