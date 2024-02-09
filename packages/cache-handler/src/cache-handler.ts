import fs, { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import type {
    CacheHandler,
    CacheHandlerParametersGet,
    CacheHandlerParametersRevalidateTag,
    CacheHandlerParametersSet,
    CacheHandlerValue,
    CachedFetchValue,
    FileSystemCacheContext,
    IncrementalCacheKindHint,
    IncrementalCacheValue,
    NonNullableRouteMetadata,
    PrerenderManifest,
    Revalidate,
    RouteMetadata,
    TagsManifest,
} from '@neshca/next-common';

import { createValidatedAgeEstimationFunction } from './helpers/create-validated-age-estimation-function';
import { isTagsManifest } from './helpers/is-tags-manifest';

const RSC_PREFETCH_SUFFIX = '.prefetch.rsc';
const RSC_SUFFIX = '.rsc';
const NEXT_DATA_SUFFIX = '.json';
const NEXT_META_SUFFIX = '.meta';

export type { CacheHandlerValue };

/**
 * Represents a record of revalidated tags.
 * The keys are the tags and the values are the Unix timestamps (in milliseconds) of when the tags were revalidated.
 */
export type RevalidatedTags = Record<string, number>;

/**
 * Represents the fallback strategy for cache handling inferred from the Next.js prerender manifest.
 * The possible values are: 'false', 'true', 'blocking', 'unknown'.
 */
type FallbackStrategy = 'false' | 'true' | 'blocking' | 'unknown';

/**
 * The number of seconds in a year.
 */
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Determines the fallback strategy based on the provided routeFallback value.
 *
 * @param routeFallback - The fallback value for the dynamic route.
 * @returns The fallback strategy. See {@link FallbackStrategy}.
 */
function determineFallback(routeFallback?: PrerenderManifest['dynamicRoutes'][string]['fallback']): FallbackStrategy {
    switch (true) {
        case routeFallback === null:
            return 'blocking';

        case routeFallback === false:
            return 'false';

        case typeof routeFallback === 'string':
            return 'true';

        default:
            return 'unknown';
    }
}

/**
 * A set of time periods and timestamps for controlling cache behavior.
 */
type LifespanParameters = {
    /**
     * The Unix timestamp (in seconds) for when the cache entry was last modified.
     */
    lastModifiedAt: number;
    /**
     * The Unix timestamp (in seconds) for when the cache entry entry becomes stale.
     * After this time, the entry is considered staled and may be used.
     */
    staleAt: number;
    /**
     * The Unix timestamp (in seconds) for when the cache entry must be removed from the cache.
     * After this time, the entry is considered expired and should not be used.
     */
    expireAt: number;
    /**
     * Time in seconds before the cache entry becomes stale.
     */
    staleAge: number;
    /**
     * Time in seconds before the cache entry becomes expired.
     */
    expireAge: number;
    /**
     * Value from Next.js revalidate option. May be false if the page has no revalidate option or the revalidate option is set to false.
     */
    revalidate: Revalidate | undefined;
};

/**
 * Represents a custom cache implementation. This interface defines essential methods for cache operations.
 */
export type Cache = {
    /**
     * A descriptive name for the cache handler instance.
     */
    name?: string;
    /**
     * Retrieves the value associated with the given key from the cache.
     *
     * @param key - The unique string identifier for the cache entry.
     *
     * @param expireAge - The expiration age of the cache entry in seconds.
     *
     * @returns A Promise that resolves to the cached value (if found), `null` or `undefined` if the entry is not found.
     *
     * @example
     * ### With auto expiration
     *
     * If your cache store supports expiration, the `get` method is straightforward.
     *
     * ```js
     *  const handler = {
     *    async get(key) {
     *      const cacheValue = await cacheStore.get(key);
     *
     *      if (!cacheValue) {
     *          return null;
     *      }
     *
     *      return cacheValue;
     *   }
     * }
     * ```
     *
     * ### Without auto expiration
     *
     * If your cache store does not support expiration, you can use the `expireAge` parameter to determine the expiration of the cache entry.
     *
     * ```js
     *  const handler = {
     *    async get(key, expireAge) {
     *      const cacheValue = await cacheStore.get(key);
     *
     *      if (!cacheValue) {
     *          return null;
     *      }
     *
     *      const lastModifiedMs = cacheValue.lastModified;
     *
     *      const ageSeconds = Math.floor((Date.now() - lastModifiedMs) / 1000);
     *
     *      if (ageSeconds > expireAge) {
     *          // you may delete it from the cache store to free up space
     *          cacheStore.delete(key);
     *
     *          return null;
     *      }
     *
     *      return cacheValue;
     *   }
     * }
     * ```
     */
    get: (key: string, expireAge: number) => Promise<CacheHandlerValue | null | undefined>;
    /**
     * Sets or updates a value in the cache store.
     *
     * @param key - The unique string identifier for the cache entry.
     *
     * @param value - The value to be stored in the cache. See {@link CacheHandlerValue}.
     *
     * @param lifespanParameters - An object containing cache control parameters for the cache entry. See {@link LifespanParameters}.
     *
     * @returns A Promise that resolves when the value has been successfully set in the cache.
     *
     * @remarks
     * ### LifespanParameters
     * If no `revalidate` option or `revalidate: false` is set in your [getStaticProps](https://nextjs.org/docs/pages/api-reference/functions/get-static-props#revalidate)
     * or [App Router `revalidate` option](https://nextjs.org/docs/app/building-your-application/data-fetching/fetching-caching-and-revalidating#time-based-revalidation),
     * the `staleAge` time period for the cache entry will be set to 1 year by default.
     *
     * Use the absolute time (`expireAt`) to set and expiration time for the cache entry in your cache store to be in sync with the file system cache.
     */
    set: (key: string, value: CacheHandlerValue, lifespanParameters: LifespanParameters) => Promise<void>;
    /**
     * Retrieves the {@link RevalidatedTags} object.
     *
     * @returns A Promise that resolves to a {@link RevalidatedTags} object
     * or either `null` or `undefined` for using tags from the next cache layer
     * or a locally maintained {@link RevalidatedTags}.
     */
    getRevalidatedTags?: () => Promise<RevalidatedTags | null | undefined>;
    /**
     * Marks a specific cache tag as revalidated. Useful for cache invalidation strategies.
     *
     * @param tag - The tag to be marked as revalidated.
     *
     * @param revalidatedAt - The timestamp (in milliseconds) of when the tag was revalidated.
     */
    revalidateTag?: (tag: string, revalidatedAt: number) => Promise<void>;
};

type NamedCache = Cache & {
    /**
     * A descriptive name or an index for the cache instance.
     */
    name: string;
};

/**
 * Represents the parameters for Time-to-Live (TTL) configuration.
 */
type TTLParameters = {
    /**
     * The time period in seconds for when the cache entry becomes stale. Defaults to 1 year.
     */
    defaultStaleAge: number;
    /**
     * Estimates the expiration age based on the stale age.
     *
     * @param staleAge - The stale age in seconds.
     *
     * @returns The expiration age in seconds.
     */
    estimateExpireAge(staleAge: number): number;
};

/**
 * Configuration options for the cache handler.
 */
export type CacheConfig = {
    /**
     * A custom cache instance or an array of cache instances that conform to the Cache interface.
     * Multiple caches can be used to implement various caching strategies or layers.
     */
    cache: Cache | (Cache | undefined | null)[];
    /**
     * Time-to-live (TTL) options for the cache entries.
     */
    ttl?: Partial<TTLParameters>;
};

/**
 * Contextual information provided during cache creation, including server directory paths and environment mode.
 */
export type CacheCreationContext = {
    /**
     * The absolute path to the Next.js server directory.
     */
    serverDistDir: string;
    /**
     * Indicates if the Next.js application is running in development mode.
     * When in development mode, caching behavior might differ.
     */
    dev?: boolean;
    /**
     * The unique identifier for the current build of the Next.js application.
     * This build ID is generated during the `next build` process and is used
     * to ensure consistency across multiple instances of the application,
     * especially when running in containerized environments. It helps in
     * identifying which version of the application is being served.
     *
     * https://nextjs.org/docs/pages/building-your-application/deploying#build-cache
     *
     * @remarks
     * Some cache values may be lost during the build process
     * because the `buildId` is defined after some cache values have already been set.
     * However, `buildId` will be defined from the beginning when you start your app.
     *
     * @example
     * ```js
     * // cache-handler.mjs
     * IncrementalCache.onCreation(async ({ buildId }) => {
     *   let redisCache;
     *
     *   if (buildId) {
     *     await client.connect();
     *
     *     redisCache = await createRedisCache({
     *       client,
     *       keyPrefix: `${buildId}:`,
     *     });
     *   }
     *
     *   const localCache = createLruCache();
     *
     *   return {
     *     cache: [redisCache, localCache],
     *   };
     * });
     * ```
     */
    buildId?: string;
};

/**
 * Represents a function that retrieves a {@link CacheConfig} based on provided options and your custom logic.
 *
 * @typeParam T - The type of the options object that the function accepts.
 *
 * @param options - An options object of type T, containing parameters that influence the cache configuration.
 *
 * @returns Either a CacheConfig object or a Promise that resolves to a {@link CacheConfig} object,
 * which specifies the cache behavior and settings.
 */
export type CreateCache<T> = (options: T) => Promise<CacheConfig> | CacheConfig;

/**
 * Represents a hook function that is called during the creation of the cache. This function allows for custom logic
 * to be executed at the time of cache instantiation, enabling dynamic configuration or initialization tasks.
 *
 * The function can either return a {@link CacheConfig} object directly or a Promise that resolves to a {@link CacheConfig},
 * allowing for asynchronous operations if needed.
 *
 * @param cacheCreationContext - The {@link CacheCreationContext} object, providing contextual information about the cache creation environment,
 * such as server directory paths and whether the application is running in development mode.
 *
 * @returns Either a CacheConfig object or a Promise that resolves to a {@link CacheConfig}, specifying how the cache should be configured.
 */
export type OnCreationHook = (cacheCreationContext: CacheCreationContext) => Promise<CacheConfig> | CacheConfig;

export class IncrementalCache implements CacheHandler {
    /**
     * Provides a descriptive name for the IncrementalCache class.
     *
     * The name includes the number of handlers and whether file system caching is used.
     * If the cache handler is not configured yet, it will return a string indicating so.
     *
     * This property is primarily intended for debugging purposes
     * and its visibility is controlled by the `NEXT_PRIVATE_DEBUG_CACHE` environment variable.
     *
     * @returns A string describing the cache handler configuration.
     *
     * @example
     * ```js
     * // cache-handler.mjs
     * IncrementalCache.onCreation(async () => {
     *   const redisCache = await createRedisCache({
     *    client,
     *   });
     *
     *   const localCache = createLruCache();
     *
     *   return {
     *     cache: [redisCache, localCache],
     *   };
     * });
     *
     * // after the Next.js called the onCreation hook
     * console.log(IncrementalCache.name);
     * // Output: "@neshca/cache-handler with 2 Handlers"
     * ```
     */
    public static get name(): string {
        if (IncrementalCache.#cacheListLength === undefined) {
            return '@neshca/cache-handler is not configured yet';
        }

        return `@neshca/cache-handler with ${IncrementalCache.#cacheListLength} Handler${
            IncrementalCache.#cacheListLength > 1 ? 's' : ''
        }`;
    }

    static #resolveCreationPromise: () => void;

    static #rejectCreationPromise: (error: unknown) => void;

    /**
     * A Promise that resolves when the `IncrementalCache.configureIncrementalCache` function has been called and the cache has been configured.
     * It prevents the cache from being used before it's ready.
     */
    static readonly #creationPromise: Promise<void> = new Promise<void>((resolve, reject) => {
        this.#resolveCreationPromise = resolve;
        this.#rejectCreationPromise = reject;
    });

    /**
     * Indicates whether the pages directory exists in the cache handler.
     * This is a fallback for when the `context._pagesDir` is not provided by Next.js.
     */
    static #hasPagesDir = false;

    static #cache: Cache;

    static #cacheListLength: number;

    static #tagsManifestPath: string;

    static #revalidatedTags: RevalidatedTags = {};

    static #debug = typeof process.env.NEXT_PRIVATE_DEBUG_CACHE !== 'undefined';

    static #defaultStaleAge: number;

    static #estimateExpireAge: (staleAge: number) => number;

    static #routeInitialRevalidateSeconds: Map<string, Revalidate> = new Map();

    static #routeRuntimeRevalidateSeconds: Map<string, Revalidate> = new Map();

    static #routeFallbackStrategy: Map<string, FallbackStrategy> = new Map();

    static #onCreationHook: OnCreationHook;

    static #getRouteRevalidateSeconds(route: string): Revalidate {
        return (
            // Users may change the revalidate option at runtime. We should use the runtime value if it exists.
            IncrementalCache.#routeRuntimeRevalidateSeconds.get(route) ??
            // If the runtime value doesn't exist, we should use the initial value.
            IncrementalCache.#routeInitialRevalidateSeconds.get(route) ??
            // If the initial value doesn't exist, we should force the revalidation by setting the revalidate to 1 second.
            1
        );
    }

    /**
     * Returns the cache control parameters based on the last modified timestamp and revalidate option.
     *
     * @param lastModified The last modified timestamp in milliseconds.
     *
     * @param revalidate The revalidate option, representing the maximum age of stale data in seconds.
     *
     * @returns The cache control parameters including expire age, expire at, last modified at, stale age, stale at and revalidate.
     *
     * @remarks
     * - `lastModifiedAt` is the Unix timestamp (in seconds) for when the cache entry was last modified.
     * - `staleAge` is the time period in seconds which equals to the `revalidate` option from Next.js pages.
     * If page has no `revalidate` option, it will be set to 1 year.
     * - `expireAge` is the time period in seconds for when the cache entry becomes expired.
     * - `staleAt` is the Unix timestamp (in seconds) for when the cache entry becomes stale.
     * - `expireAt` is the Unix timestamp (in seconds) for when the cache entry must be removed from the cache.
     * - `revalidate` is the value from Next.js revalidate option.
     * May be false if the page has no revalidate option or the revalidate option is set to false.
     */
    static #getLifespanParameters(lastModified: number, revalidate?: Revalidate): LifespanParameters {
        const lastModifiedAt = Math.floor(lastModified / 1000);
        const staleAge = revalidate || IncrementalCache.#defaultStaleAge;
        const staleAt = lastModifiedAt + staleAge;
        const expireAge = IncrementalCache.#estimateExpireAge(staleAge);
        const expireAt = lastModifiedAt + expireAge;

        return { expireAge, expireAt, lastModifiedAt, revalidate, staleAge, staleAt };
    }

    /**
     * Registers a hook to be called during the creation of an IncrementalCache instance.
     * This method allows for custom cache configurations to be applied at the time of cache instantiation.
     *
     * The provided {@link OnCreationHook} function can perform initialization tasks, modify cache settings,
     * or integrate additional logic into the cache creation process. This function can either return a {@link CacheConfig}
     * object directly for synchronous operations, or a `Promise` that resolves to a {@link CacheConfig} for asynchronous operations.
     *
     * Usage of this method is typically for advanced scenarios where default caching behavior needs to be altered
     * or extended based on specific application requirements or environmental conditions.
     *
     * @param onCreationHook - The {@link OnCreationHook} function to be called during cache creation.
     */
    public static onCreation(onCreationHook: OnCreationHook): void {
        IncrementalCache.#onCreationHook = onCreationHook;
    }

    static async #configureIncrementalCache(cacheCreationContext: CacheCreationContext): Promise<void> {
        // Retrieve cache configuration by invoking the onCreation hook with the provided context
        const config = IncrementalCache.#onCreationHook(cacheCreationContext);

        // Wait for the cache configuration to be resolved
        const { cache, ttl = {} } = await config;

        const { defaultStaleAge, estimateExpireAge } = ttl;

        IncrementalCache.#defaultStaleAge = typeof defaultStaleAge === 'number' ? defaultStaleAge : ONE_YEAR;

        IncrementalCache.#estimateExpireAge = createValidatedAgeEstimationFunction(estimateExpireAge);

        // Extract the server distribution directory from the cache creation context
        const { serverDistDir, dev } = cacheCreationContext;

        // Notify the user that the cache is not used in development mode
        if (dev) {
            console.warn('Next.js does not use the cache in development mode. Use production mode to enable caching.');
        }

        // Check if the pages directory exists and set the flag accordingly
        IncrementalCache.#hasPagesDir = fs.existsSync(path.join(serverDistDir, 'pages'));

        // Define the path for the tags manifest file
        IncrementalCache.#tagsManifestPath = path.join(
            serverDistDir,
            '..',
            'cache',
            'fetch-cache',
            'tags-manifest.json',
        );

        try {
            // Ensure the directory for the tags manifest exists
            await fsPromises.mkdir(path.dirname(IncrementalCache.#tagsManifestPath), { recursive: true });

            // Read the tags manifest from the file system
            const tagsManifestData = await fsPromises.readFile(IncrementalCache.#tagsManifestPath, 'utf-8');

            // Parse the tags manifest data
            const tagsManifestFromFileSystem = JSON.parse(tagsManifestData) as unknown;

            if (isTagsManifest(tagsManifestFromFileSystem)) {
                for (const [tag, { revalidatedAt }] of Object.entries(tagsManifestFromFileSystem.items)) {
                    IncrementalCache.#revalidatedTags[tag] = revalidatedAt;
                }
            }
        } catch (_error) {
            // If the file doesn't exist, use the default tagsManifest
        }

        try {
            const prerenderManifestData = await fsPromises.readFile(
                path.join(serverDistDir, '..', 'prerender-manifest.json'),
                'utf-8',
            );
            const prerenderManifest = JSON.parse(prerenderManifestData) as PrerenderManifest;

            for (const [route, { initialRevalidateSeconds, srcRoute }] of Object.entries(prerenderManifest.routes)) {
                // Set the initial revalidate seconds for the route
                IncrementalCache.#routeInitialRevalidateSeconds.set(route, initialRevalidateSeconds);
                // Set the fallback strategy for the route
                IncrementalCache.#routeFallbackStrategy.set(
                    route,
                    determineFallback(prerenderManifest.dynamicRoutes[srcRoute || '']?.fallback),
                );
            }
        } catch (_error) {}

        // Add default names to the cache handlers if they don't have one
        const cacheHandlersList: NamedCache[] = [];

        if (Array.isArray(cache)) {
            for (const [index, cacheItem] of cache.entries()) {
                if (cacheItem) {
                    cacheItem.name = cacheItem.name || index.toString(10);
                    cacheHandlersList.push(cacheItem as NamedCache);
                }
            }
        } else {
            cache.name = cache.name || '0';
            cacheHandlersList.push(cache as NamedCache);
        }

        IncrementalCache.#cacheListLength = cacheHandlersList.length;

        IncrementalCache.#cache = {
            async get(key, expireAge) {
                for await (const cacheItem of cacheHandlersList) {
                    try {
                        const cacheValue = await cacheItem.get(key, expireAge);

                        if (IncrementalCache.#debug) {
                            console.info(`get from "${cacheItem.name}"`, key, Boolean(cacheValue));
                        }

                        return cacheValue;
                    } catch (error) {
                        if (IncrementalCache.#debug) {
                            console.warn(
                                `Cache handler "${cacheItem.name}" failed to get value for key "${key}".`,
                                error,
                            );
                        }
                    }
                }

                return null;
            },
            async set(key, value, lifespanParameters) {
                await Promise.allSettled(
                    cacheHandlersList.map((cacheItem) => {
                        try {
                            return cacheItem.set(key, value, lifespanParameters);
                        } catch (error) {
                            if (IncrementalCache.#debug) {
                                console.warn(
                                    `Cache handler "${cacheItem.name}" failed to set value for key "${key}".`,
                                    error,
                                );
                            }
                        }

                        return Promise.resolve();
                    }),
                );
            },
            async getRevalidatedTags() {
                for await (const cacheItem of cacheHandlersList) {
                    try {
                        const revalidatedTags = await cacheItem.getRevalidatedTags?.();

                        return revalidatedTags;
                    } catch (error) {
                        if (IncrementalCache.#debug) {
                            console.warn(`Cache handler "${cacheItem.name}" failed to get revalidated tags.`, error);
                        }
                    }
                }
            },
            async revalidateTag(tag, revalidatedAt) {
                await Promise.allSettled(
                    cacheHandlersList.map((cacheItem) => {
                        try {
                            return cacheItem.revalidateTag?.(tag, revalidatedAt);
                        } catch (error) {
                            if (IncrementalCache.#debug) {
                                console.warn(
                                    `Cache handler "${cacheItem.name}" failed to revalidate tag "${tag}".`,
                                    error,
                                );
                            }
                        }

                        return Promise.resolve();
                    }),
                );
            },
        };
    }

    readonly #revalidatedTagsArray: FileSystemCacheContext['revalidatedTags'];
    readonly #appDir: FileSystemCacheContext['_appDir'];
    readonly #pagesDir: FileSystemCacheContext['_pagesDir'] | undefined;
    readonly #serverDistDir: FileSystemCacheContext['serverDistDir'];
    readonly #experimental: FileSystemCacheContext['experimental'];

    private constructor(context: FileSystemCacheContext) {
        this.#revalidatedTagsArray = context.revalidatedTags ?? [];
        this.#appDir = Boolean(context._appDir);
        this.#pagesDir = context._pagesDir;
        this.#serverDistDir = context.serverDistDir;
        this.#experimental = { ppr: context?.experimental?.ppr ?? false };

        if (!IncrementalCache.#cache) {
            let buildId: string | undefined;

            try {
                buildId = fs.readFileSync(path.join(this.#serverDistDir, '..', 'BUILD_ID'), 'utf-8');
            } catch (_error) {
                buildId = undefined;
            }

            IncrementalCache.#configureIncrementalCache({
                dev: context.dev,
                serverDistDir: this.#serverDistDir,
                buildId,
            })
                .then(IncrementalCache.#resolveCreationPromise)
                .catch(IncrementalCache.#rejectCreationPromise);
        }
    }

    async #readCacheFromFileSystem(
        cacheKey: string,
        expireAge: number,
        kindHint?: IncrementalCacheKindHint,
        tags?: string[],
    ): Promise<CacheHandlerValue | null> {
        try {
            const bodyFilePath = this.#getFilePath(`${cacheKey}.body`, 'app');

            const bodyFileData = await fsPromises.readFile(bodyFilePath);
            const { mtime } = await fsPromises.stat(bodyFilePath);

            const lastModified = mtime.getTime();

            const metaFileData = await fsPromises.readFile(bodyFilePath.replace(/\.body$/, NEXT_META_SUFFIX), 'utf-8');
            const meta: NonNullableRouteMetadata = JSON.parse(metaFileData) as NonNullableRouteMetadata;

            const cacheEntry: CacheHandlerValue = {
                lastModified,
                value: {
                    kind: 'ROUTE',
                    body: bodyFileData,
                    headers: meta.headers,
                    status: meta.status,
                },
            };

            return cacheEntry;
        } catch (_) {
            // no .meta data for the related key
        }

        try {
            // Determine the file kind if we didn't know it already.
            let kind = kindHint;

            if (!kind) {
                kind = this.#detectFileKind(`${cacheKey}.html`);
            }

            const isAppPath = kind === 'app';

            const pageFilePath = this.#getFilePath(kind === 'fetch' ? cacheKey : `${cacheKey}.html`, kind);

            const pageFile = await fsPromises.readFile(pageFilePath, 'utf-8');
            const { mtime } = await fsPromises.stat(pageFilePath);

            const lastModified = mtime.getTime();

            const ageSeconds = Math.floor((Date.now() - lastModified) / 1000);

            const fallback = IncrementalCache.#routeFallbackStrategy.get(cacheKey);

            const pageHasFallbackFalse = fallback === 'false';

            if (!pageHasFallbackFalse && ageSeconds > expireAge) {
                return null;
            }

            if (kind === 'fetch') {
                const parsedData = JSON.parse(pageFile) as CachedFetchValue;

                const cachedData = {
                    lastModified,
                    value: parsedData,
                };

                if (cachedData.value?.kind === 'FETCH') {
                    const cachedTags = cachedData.value.tags;

                    // update stored tags if a new one is being added
                    // TODO: remove this when we can send the tags
                    // via header on GET same as SET
                    if (!tags?.every((tag) => cachedTags?.includes(tag))) {
                        if (IncrementalCache.#debug) {
                            console.info('tags vs cachedTags mismatch', tags, cachedTags);
                        }
                        await this.set(cacheKey, cachedData.value, { tags });
                    }
                }

                return cachedData;
            }

            const pageDataFilePath = isAppPath
                ? this.#getFilePath(`${cacheKey}${this.#experimental.ppr ? RSC_PREFETCH_SUFFIX : RSC_SUFFIX}`, 'app')
                : this.#getFilePath(`${cacheKey}${NEXT_DATA_SUFFIX}`, 'pages');

            const pageDataFile = await fsPromises.readFile(pageDataFilePath, 'utf-8');

            const pageData = isAppPath ? pageDataFile : (JSON.parse(pageDataFile) as object);

            let meta: RouteMetadata | undefined;

            if (isAppPath) {
                try {
                    const metaFileData = await fsPromises.readFile(
                        pageFilePath.replace(/\.html$/, NEXT_META_SUFFIX),
                        'utf-8',
                    );
                    meta = JSON.parse(metaFileData) as RouteMetadata;
                } catch {
                    // no .meta data for the related key
                }
            }

            return {
                lastModified,
                value: {
                    kind: 'PAGE',
                    html: pageFile,
                    pageData,
                    postponed: meta?.postponed,
                    headers: meta?.headers,
                    status: meta?.status,
                },
            };
        } catch (_) {
            // unable to get data from the file system
        }

        return null;
    }

    async #revalidateCachedData(cachedData: CacheHandlerValue, tags: string[], softTags: string[]): Promise<boolean> {
        // credits to Next.js for the following code
        if (cachedData.value?.kind === 'PAGE') {
            let cacheTags: undefined | string[];
            const tagsHeader = cachedData.value.headers?.['x-next-cache-tags'];

            if (typeof tagsHeader === 'string') {
                cacheTags = tagsHeader.split(',');
            }

            const revalidatedTags =
                (await IncrementalCache.#cache.getRevalidatedTags?.()) ?? IncrementalCache.#revalidatedTags;

            if (cacheTags?.length) {
                const isStale = cacheTags.some((tag) => {
                    const revalidatedAt = revalidatedTags[tag];

                    return (
                        typeof revalidatedAt === 'number' && revalidatedAt >= (cachedData?.lastModified || Date.now())
                    );
                });

                // we trigger a blocking validation if an ISR page
                // had a tag revalidated, if we want to be a background
                // revalidation instead we return cachedData.lastModified = -1
                return isStale;
            }
        }

        if (cachedData.value?.kind === 'FETCH') {
            const combinedTags = [...tags, ...softTags];

            const revalidatedTags =
                (await IncrementalCache.#cache.getRevalidatedTags?.()) ?? IncrementalCache.#revalidatedTags;

            const wasRevalidated = combinedTags.some((tag: string) => {
                if (this.#revalidatedTagsArray.includes(tag)) {
                    return true;
                }

                const revalidatedAt = revalidatedTags[tag];

                return typeof revalidatedAt === 'number' && revalidatedAt >= (cachedData?.lastModified || Date.now());
            });

            // When revalidate tag is called we don't return
            // stale cachedData so it's updated right away
            return wasRevalidated;
        }

        return false;
    }

    public async get(...args: CacheHandlerParametersGet): Promise<CacheHandlerValue | null> {
        await IncrementalCache.#creationPromise;

        const [cacheKey, ctx = {}] = args;

        const { tags = [], softTags = [], kindHint, revalidate } = ctx;

        // there is no revalidate option for the values from the Pages Router, so we need to infer it from the initial value or the runtime value
        const inferredRevalidate = revalidate ?? IncrementalCache.#getRouteRevalidateSeconds(cacheKey);

        // if inferredRevalidate is false, we set the expireAge to 1 year
        const expireAge = IncrementalCache.#estimateExpireAge(inferredRevalidate || IncrementalCache.#defaultStaleAge);

        let cachedData: CacheHandlerValue | null | undefined = await IncrementalCache.#cache.get(
            cacheKey,
            Math.floor(expireAge),
        );

        if (!cachedData) {
            cachedData = await this.#readCacheFromFileSystem(cacheKey, expireAge, kindHint, tags);

            if (IncrementalCache.#debug) {
                console.info('get from file system', cacheKey, tags, kindHint, 'got any value', Boolean(cachedData));
            }

            if (cachedData) {
                await IncrementalCache.#cache.set(
                    cacheKey,
                    cachedData,
                    IncrementalCache.#getLifespanParameters(cachedData.lastModified, inferredRevalidate),
                );
            }
        }

        if (!cachedData) {
            return null;
        }

        const revalidated = await this.#revalidateCachedData(cachedData, tags, softTags);

        if (revalidated) {
            return null;
        }

        return cachedData;
    }

    async #writeCacheToFileSystem(cacheKey: string, data: IncrementalCacheValue, tags: string[] = []): Promise<void> {
        switch (data.kind) {
            case 'FETCH': {
                const filePath = this.#getFilePath(cacheKey, 'fetch');
                await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
                await fsPromises.writeFile(
                    filePath,
                    JSON.stringify({
                        ...data,
                        tags,
                    }),
                );

                return;
            }
            case 'PAGE': {
                const isAppPath = typeof data.pageData === 'string';
                const htmlPath = this.#getFilePath(`${cacheKey}.html`, isAppPath ? 'app' : 'pages');
                await fsPromises.mkdir(path.dirname(htmlPath), { recursive: true });
                await fsPromises.writeFile(htmlPath, data.html);

                await fsPromises.writeFile(
                    this.#getFilePath(
                        `${cacheKey}${isAppPath ? RSC_SUFFIX : NEXT_DATA_SUFFIX}`,
                        isAppPath ? 'app' : 'pages',
                    ),
                    isAppPath ? JSON.stringify(data.pageData) : JSON.stringify(data.pageData),
                );

                if (data.headers || data.status) {
                    const meta: RouteMetadata = {
                        headers: data.headers,
                        status: data.status,
                        postponed: data.postponed,
                    };

                    await fsPromises.writeFile(htmlPath.replace(/\.html$/, NEXT_META_SUFFIX), JSON.stringify(meta));
                }
                return;
            }
            case 'ROUTE': {
                const filePath = this.#getFilePath(`${cacheKey}.body`, 'app');
                const meta: RouteMetadata = {
                    headers: data.headers,
                    status: data.status,
                    postponed: undefined,
                };

                await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
                await fsPromises.writeFile(filePath, data.body);
                await fsPromises.writeFile(
                    filePath.replace(/\.body$/, NEXT_META_SUFFIX),
                    JSON.stringify(meta, null, 2),
                );

                return;
            }
            default: {
                break;
            }
        }
    }

    public async set(...args: CacheHandlerParametersSet): Promise<void> {
        await IncrementalCache.#creationPromise;

        const [cacheKey, data, ctx] = args;

        const { revalidate, tags } = ctx;

        const lastModified = Date.now();

        const inferredRevalidate = revalidate ?? IncrementalCache.#routeInitialRevalidateSeconds.get(cacheKey);

        await IncrementalCache.#cache.set(
            cacheKey,
            {
                value: data,
                lastModified,
            },
            IncrementalCache.#getLifespanParameters(lastModified, inferredRevalidate),
        );

        typeof revalidate !== 'undefined' && IncrementalCache.#routeRuntimeRevalidateSeconds.set(cacheKey, revalidate);

        if (IncrementalCache.#debug) {
            console.info('set to external cache store', cacheKey);
        }

        if (data) {
            await this.#writeCacheToFileSystem(cacheKey, data, tags);

            if (IncrementalCache.#debug) {
                console.info('set to file system', cacheKey);
            }
        }
    }

    public async revalidateTag(...args: CacheHandlerParametersRevalidateTag): Promise<void> {
        await IncrementalCache.#creationPromise;

        const [tag] = args;

        if (IncrementalCache.#debug) {
            console.info('revalidateTag', tag);
        }

        await IncrementalCache.#cache.revalidateTag?.(tag, Date.now());

        if (IncrementalCache.#debug) {
            console.info('updated external revalidated tags');
        }

        IncrementalCache.#revalidatedTags[tag] = Date.now();

        if (IncrementalCache.#debug) {
            console.info('updated local revalidated tags');
        }

        try {
            const tagsManifest: TagsManifest = {
                version: 1,
                items: {},
            };

            for (const [revalidatedTag, revalidatedAt] of Object.entries(IncrementalCache.#revalidatedTags)) {
                tagsManifest.items[revalidatedTag] = {
                    revalidatedAt,
                };
            }

            await fsPromises.writeFile(IncrementalCache.#tagsManifestPath, JSON.stringify(tagsManifest));

            if (IncrementalCache.#debug) {
                console.info('updated tags manifest file');
            }
        } catch (error) {
            console.warn('failed to update tags manifest.', error);
        }
    }

    // credits to Next.js for the following code
    #detectFileKind(pathname: string): 'app' | 'pages' {
        const pagesDir = this.#pagesDir ?? IncrementalCache.#hasPagesDir;

        if (!(this.#appDir || pagesDir)) {
            throw new Error("Invariant: Can't determine file path kind, no page directory enabled");
        }

        // If app directory isn't enabled, then assume it's pages and avoid the fs
        // hit.
        if (!this.#appDir && pagesDir) {
            return 'pages';
        }
        // Otherwise assume it's a pages file if the pages directory isn't enabled.
        if (this.#appDir && !pagesDir) {
            return 'app';
        }

        // If both are enabled, we need to test each in order, starting with
        // `pages`.
        let filePath = this.#getFilePath(pathname, 'pages');
        if (fs.existsSync(filePath)) {
            return 'pages';
        }

        filePath = this.#getFilePath(pathname, 'app');
        if (fs.existsSync(filePath)) {
            return 'app';
        }

        throw new Error(`Invariant: Unable to determine file path kind for ${pathname}`);
    }

    // credits to Next.js for the following code
    #getFilePath(pathname: string, kind: 'app' | 'fetch' | 'pages'): string {
        switch (kind) {
            case 'fetch':
                // we store in .next/cache/fetch-cache so it can be persisted
                // across deploys
                return path.join(this.#serverDistDir, '..', 'cache', 'fetch-cache', pathname);
            case 'pages':
                return path.join(this.#serverDistDir, 'pages', pathname);
            case 'app':
                return path.join(this.#serverDistDir, 'app', pathname);
            default:
                throw new Error("Invariant: Can't determine file path kind");
        }
    }

    resetRequestCache(): void {
        // not implemented yet
    }
}
