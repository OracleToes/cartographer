/**
 * The UI has two sources of activity: submissions admitted by the person and
 * Pi's actual live run, which can also start after a collapse or a timed wake.
 * A late settlement of a submission must not hide a newer, autonomous run.
 */
export class RunActivity {
  private submissions = 0;
  private live = false;

  get running(): boolean {
    return this.submissions > 0 || this.live;
  }

  beginSubmission(): void {
    this.submissions += 1;
  }

  endSubmission(): void {
    this.submissions = Math.max(0, this.submissions - 1);
  }

  observeRun(running: boolean): void {
    this.live = running;
  }
}
