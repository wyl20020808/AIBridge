/**
 * Synthetic credential shapes for the security tests.
 *
 * Every value is assembled at runtime from fragments, so this committed file never contains a
 * credential-shaped literal for `check-no-secret-leak.mjs` to flag. The values are obviously fake
 * and exist only so the input-safety layer has something to detect.
 */
export type SyntheticSecrets = {
  readonly OPENAI_STYLE_KEY: string;
  readonly GITHUB_TOKEN: string;
  readonly AWS_ACCESS_KEY_ID: string;
  readonly SLACK_TOKEN: string;
  readonly PEM_PRIVATE_KEY: string;
  readonly JWT: string;
  readonly BEARER_HEADER: string;
  readonly API_KEY_ASSIGNMENT: string;
  readonly SECRET_ASSIGNMENT: string;
};

export function syntheticSecrets(): SyntheticSecrets {
  return {
    OPENAI_STYLE_KEY: `sk-${'A'.repeat(32)}`,
    GITHUB_TOKEN: `ghp_${'A'.repeat(36)}`,
    AWS_ACCESS_KEY_ID: `AKIA${'A'.repeat(16)}`,
    SLACK_TOKEN: `xoxb-${'1'.repeat(24)}`,
    PEM_PRIVATE_KEY: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
    JWT: ['eyJ', 'a'.repeat(10), '.', 'b'.repeat(10), '.', 'c'.repeat(10)].join(''),
    BEARER_HEADER: ['Bearer ', 'A'.repeat(24)].join(''),
    API_KEY_ASSIGNMENT: ['api_key=', 'A'.repeat(16)].join(''),
    SECRET_ASSIGNMENT: ['secret=', 'A'.repeat(16)].join(''),
  };
}

/** The single synthetic value used where one key is enough. */
export function syntheticKey(): string {
  return `sk-${'A'.repeat(32)}`;
}
