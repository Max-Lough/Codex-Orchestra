'use strict';

function quoteWindowsShimToken(value) {
  const quote = String.fromCharCode(34);
  const token = String(value);
  // The batch file receives the quoted spelling through %*. A closing quote
  // preceded by an odd run of backslashes is parsed as a literal quote by the
  // eventual native executable, merging every following flag into that argv
  // entry. Doubling the trailing run preserves it and keeps the quote syntax.
  return quote + token
    .split(quote).join(quote + quote)
    .replace(/(\\+)$/, '$1$1') + quote;
}

function engineLaunchSpec(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command))) {
    const words = [command].concat(args);
    if (words.some((word) => String(word).includes('%'))) {
      throw new Error('percent characters are not supported in Windows command-shim tokens');
    }
    const line = words
      .map((word) => quoteWindowsShimToken(word))
      .join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + line + '"'],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: args.slice(), windowsVerbatimArguments: false };
}

function engineSpawnOptions(options) {
  return Object.assign({
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  }, options || {});
}

module.exports = { engineLaunchSpec, engineSpawnOptions };
