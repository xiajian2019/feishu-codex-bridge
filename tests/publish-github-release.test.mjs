import { describe, expect, it } from 'bun:test';

import { parsePublishArguments } from '../scripts/publish-github-release.mjs';

describe('GitHub release publisher', () => {
  it('defaults to the package version and supports release overrides', () => {
    expect(parsePublishArguments([
      '--tag', 'v0.2.0',
      '--remote=upstream',
      '--branch', 'main',
      '--message', 'Release v0.2.0',
      '--skip-build',
      '--dry-run',
    ], '0.1.0')).toMatchObject({
      tag: 'v0.2.0',
      remote: 'upstream',
      branch: 'main',
      commitMessage: 'Release v0.2.0',
      skipBuild: true,
      dryRun: true,
    });
  });

  it('uses the package version when no tag is specified', () => {
    expect(parsePublishArguments([], '1.2.3')).toMatchObject({
      tag: 'v1.2.3',
      remote: 'origin',
      branch: 'main',
    });
  });
});
