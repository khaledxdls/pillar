import ora, { type Ora } from 'ora';

/**
 * Run an async operation with a spinner.
 * Returns the result of the operation.
 */
export async function withSpinner<T>(
  text: string,
  operation: (spinner: Ora) => Promise<T>,
): Promise<T> {
  const spinner = ora({ text, color: 'cyan' }).start();
  try {
    const result = await operation(spinner);
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}
