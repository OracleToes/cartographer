/**
 * The name the harness uses for the person at the keyboard.
 *
 * The agent reads a name, not a role: the strings the model sees say who it is
 * talking to, and that is the account that launched Carto. A configuration
 * setting (`userName`, or `--user`) overrides it, for a machine whose login name
 * is not what someone wants to be called while working.
 *
 * Nothing else here is a name. There is no "person" and no "user" in what the
 * agent reads — the words it was given before this were a placeholder standing
 * where somebody's actual name belongs.
 */
import { userInfo } from "node:os";

/** Said only when nothing names the person at all: no login name and no setting. */
export const UNNAMED_PERSON = "someone";

/** The first of the usual login variables that holds something, if any. */
function fromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  for (const key of ["USER", "LOGNAME", "USERNAME"]) {
    const value = environment[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** What the OS knows about the account running the process. */
export type LoginReader = () => { username: string };

/**
 * The launching account's name: the OS first, because it is the account that
 * really ran the process, then the environment, which is all a bare uid leaves.
 * The reader is a parameter so the fallback can be exercised by a test rather
 * than taken on faith.
 */
export function launchingUserName(environment: NodeJS.ProcessEnv = process.env, read: LoginReader = userInfo): string {
  try {
    const name = read().username.trim();
    if (name.length > 0) return name;
  } catch {
    // A uid with no passwd entry: nothing to read there, so read the environment.
  }
  return fromEnvironment(environment) ?? UNNAMED_PERSON;
}

/** The configured name when there is one, and the launching account's otherwise. */
export function personName(
  configured?: string,
  environment: NodeJS.ProcessEnv = process.env,
  read: LoginReader = userInfo,
): string {
  const trimmed = configured?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : launchingUserName(environment, read);
}
