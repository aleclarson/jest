/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Path} from 'types/Config';
import type {InternalHasteMap} from 'types/HasteMap';
import type {CrawlerOptions} from '../types';

import * as fastPath from '../lib/fast_path';
import normalizePathSep from '../lib/normalize_path_sep';
import {existsSync} from 'fs';
import path from 'path';
import realpath from 'realpath-native';
import watchman from 'fb-watchman';
import H from '../constants';

const watchmanURL =
  'https://facebook.github.io/watchman/docs/troubleshooting.html';

// Matches symlinks in "node_modules" directories.
const nodeModulesExpression = [
  'allof',
  ['type', 'l'],
  ['anyof'].concat(
    ['**/node_modules/*', '**/node_modules/@*/*'].map(glob => [
      'match',
      glob,
      'wholename',
      {includedotfiles: true},
    ]),
  ),
];

const NODE_MODULES = path.sep + 'node_modules' + path.sep;

function WatchmanError(error: Error): Error {
  error.message =
    `Watchman error: ${error.message.trim()}. Make sure watchman ` +
    `is running for this project. See ${watchmanURL}.`;
  return error;
}

module.exports = async function watchmanCrawl(
  options: CrawlerOptions,
): Promise<InternalHasteMap> {
  const {data, extensions, ignore, rootDir} = options;
  const client = new watchman.Client();

  let clientError;
  client.on('error', error => (clientError = WatchmanError(error)));

  const cmd = (...args) =>
    new Promise((resolve, reject) =>
      client.command(args, (error, result) =>
        error ? reject(WatchmanError(error)) : resolve(result),
      ),
    );

  const fields = ['name', 'type', 'exists', 'mtime_ms'];
  if (options.computeSha1) {
    const {capabilities} = await cmd('list-capabilities');
    if (capabilities.includes('field-content.sha1hex')) {
      fields.push('content.sha1hex');
    }
  }

  // Clone the clockspec cache to avoid mutations during the watch phase.
  const clocks = new Map(data.clocks);

  /**
   * Fetch an array of files that match the given expression and are contained
   * by the given `watchRoot` (with directory filters applied).
   *
   * When the `watchRoot` has a cached Watchman clockspec, only changed files
   * are returned. The cloned clockspec cache is updated on every query.
   *
   * The given `watchRoot` must be absolute.
   */
  const query = async (
    watchRoot: Path,
    dirs: Array<Path>,
    expression: Array<any>,
  ) => {
    if (dirs.length) {
      expression = [
        'allof',
        ['anyof'].concat(dirs.map(dir => ['dirname', dir])),
        expression,
      ];
    }

    /**
     * Use the `since` generator if we have a clock available.
     * Otherwise use the `glob` filter.
     */
    const relativeRoot = fastPath.relative(rootDir, watchRoot) || '.';
    const response = await cmd('query', watchRoot, {
      expression,
      fields,
      since: data.clocks.get(relativeRoot),
    });

    if ('warning' in response) {
      console.warn('watchman warning:', response.warning);
    }

    clocks.set(relativeRoot, response.clock);
    return response;
  };

  /**
   * Watchman often consolidates directories that share an ancestor.
   * These directories are tracked and then used to filter queries
   * of the consolidated root.
   */
  const watched = new Map();

  /**
   * The search for linked dependencies is a multi-pass process, because we
   * can't assume all symlink targets are inside a project root.
   */
  const watchQueue = [...options.roots];
  for (const key of data.links.keys()) {
    const linkRoot = path.resolve(rootDir, key);
    if (!watchQueue.includes(linkRoot) && existsSync(linkRoot)) {
      watchQueue.push(linkRoot);
    }
  }

  /**
   * Register a directory with Watchman, then crawl it for symlinks.
   * Any symlinks found in "node_modules" are added to the watch queue,
   * and this process repeats until the entire dependency tree is crawled.
   */
  const watch = async (root: Path) => {
    const watchResp = await cmd('watch-project', root);
    const watchRoot =
      fastPath.relative(rootDir, normalizePathSep(watchResp.watch)) || '.';

    let dirs = watched.get(watchRoot);
    if (!dirs) {
      watched.set(watchRoot, (dirs = []));
    } else if (!dirs.length) {
      return; // Ensure no directory filters are used.
    }

    const dir = normalizePathSep(watchResp.relative_path || '');
    if (dir) {
      // Avoid crawling the same directory twice.
      if (dirs.includes(dir)) return;
      dirs.push(dir);
    }
    // Ensure no directory filters are used.
    else if (dirs.length) {
      dirs.length = 0;
    }

    // Perform a deep crawl in search of linked dependencies.
    const queryResp = await query(
      path.resolve(rootDir, watchRoot),
      dir ? [dir] : [],
      nodeModulesExpression,
    );

    // Reset the symlink map if Watchman refreshed.
    const cacheId = path.join(watchRoot, dir);
    let cache = !queryResp.is_fresh_instance && data.links.get(cacheId);
    if (!cache) {
      data.links.set(cacheId, (cache = new Map()));
    }

    // These files are guaranteed to be symlinks in a node_modules directory.
    for (const link of queryResp.files) {
      const name = normalizePathSep(link.name);
      const cacheKey = dir ? fastPath.relative(dir, name) : name;
      const linkPath = path.resolve(rootDir, path.join(watchRoot, name));
      if (!link.exists || ignore(linkPath)) {
        cache.delete(cacheKey);
        continue;
      }
      let target;
      try {
        target = realpath.sync(linkPath);
      } catch (e) {
        continue; // Skip broken symlinks.
      }
      // Clear the resolved target if the symlink has been modified.
      const cacheData = cache.get(cacheKey);
      const mtime = testModified(cacheData, link.mtime_ms);
      if (mtime !== 0) {
        cache.set(cacheKey, [target, mtime]);
      }
      // When the symlink's target is contained in node_modules, we can assume
      // the package is _not_ locally developed.
      if (!target.includes(NODE_MODULES)) {
        watchQueue.push(linkPath);
      }
    }
  };

  try {
    while (watchQueue.length) {
      const promise = Promise.all(watchQueue.map(watch));
      watchQueue.length = 0;
      await promise;
    }

    const crawlExpression = [
      'anyof',
      ['type', 'l'],
      [
        'allof',
        ['type', 'f'],
        ['anyof'].concat(extensions.map(extension => ['suffix', extension])),
      ],
    ];

    let isFresh = false;
    const watchRoots = Array.from(watched.keys());
    const crawled = await Promise.all(
      watchRoots.map(async watchRoot => {
        const queryResp = await query(
          path.resolve(rootDir, watchRoot),
          watched.get(watchRoot) || [],
          crawlExpression,
        );
        if (!isFresh) {
          isFresh = queryResp.is_fresh_instance;
        }
        return queryResp.files;
      }),
    );

    // Reset the file map if Watchman refreshed.
    if (isFresh) {
      data.files = new Map();
    }

    // Update the file map and symlink map.
    crawled.forEach((files, i) => {
      const watchRoot = watchRoots[i];
      const root = path.resolve(rootDir, watchRoot);
      const dirs = watched.get(watchRoot) || [];
      for (const file of files) {
        const name = normalizePathSep(file.name);
        const isLink = file.type === 'l';

        // Files and symlinks use separate caches.
        let cache, cacheKey;
        if (isLink) {
          const dir = dirs.length
            ? dirs.find(dir => name.startsWith(dir + path.sep)) || ''
            : '';
          cacheKey = dir ? fastPath.relative(dir, name) : name;
          cache = data.links.get(path.join(watchRoot, dir));
          if (!cache) continue;
        } else {
          cacheKey = path.join(watchRoot, name);
          cache = data.files;
        }

        if (!file.exists || ignore(path.join(root, name))) {
          cache.delete(cacheKey);
          continue;
        }

        let sha1hex = file['content.sha1hex'];
        if (typeof sha1hex !== 'string' || sha1hex.length !== 40) {
          sha1hex = null;
        }

        const cacheData: any = cache.get(cacheKey);
        const mtime = testModified(cacheData, file.mtime_ms);
        if (mtime !== 0) {
          // See ../constants.js
          const newCacheData: any = isLink
            ? [undefined, mtime]
            : sha1hex && cacheData && cacheData[H.SHA1] === sha1hex
            ? [cacheData[0], mtime].concat(cacheData.slice(2))
            : ['', mtime, 0, [], sha1hex];

          cache.set(cacheKey, newCacheData);
        }
      }
    });
  } finally {
    client.end();
  }
  if (clientError) {
    throw clientError;
  }
  data.clocks = clocks;
  return data;
};

function testModified(cacheData, mtime) {
  if (typeof mtime !== 'number') {
    mtime = mtime.toNumber();
  }
  return !cacheData || cacheData[H.MTIME] !== mtime ? mtime : 0;
}
