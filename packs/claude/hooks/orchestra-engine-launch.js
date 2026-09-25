'use strict';

function engineLaunchSpec(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command))) {
    const words = [command].concat(args);
    if (words.some((word) => String(word).includes('%'))) {
      throw new Error('percent characters are not supported in Windows command-shim tokens');
    }
    const line = words
      .map((word) => '"' + String(word).replace(/"/g, '""') + '"')
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
