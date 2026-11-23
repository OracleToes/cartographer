/**
 * The person's marks on one Brain record, as the two books (Atlas, Ledger) give
 * them (§4.1). The Context view has the same four acts on its own rows: `a`
 * marks for archive, `d` marks for delete, `u` withdraws, `!` arms apply-now.
 * One class holds the act, so a book cannot read the keys differently from the
 * Context view or from the other book; the app routes the callbacks into the
 * same functions the Context view's use.
 */
import { matchesKey } from "@earendil-works/pi-tui";

export type RecordAction = "archive" | "delete";

export class RecordControls {
  /** A mark on the record: `now` is true when `!` armed it, and arming is spent by the mark. */
  onMark?: (id: string, action: RecordAction, now: boolean) => void;
  /** Withdraw the person's mark on the record. */
  onWithdraw?: (id: string) => void;

  private armed = false;

  get nowArmed(): boolean {
    return this.armed;
  }

  /** Arm or disarm apply-now, and say which it is now: the next mark is spent either way. */
  toggleApplyNow(): boolean {
    this.armed = !this.armed;
    return this.armed;
  }

  mark(id: string | undefined, action: RecordAction): void {
    if (id === undefined) return;
    const now = this.armed;
    this.armed = false;
    this.onMark?.(id, action, now);
  }

  withdraw(id: string | undefined): void {
    if (id === undefined) return;
    this.armed = false;
    this.onWithdraw?.(id);
  }

  /** The keys, for a view that has the selected record's id. True when one was taken. */
  handleKey(data: string, id: string | undefined): boolean {
    if (matchesKey(data, "!")) {
      this.toggleApplyNow();
      return true;
    }
    if (matchesKey(data, "a")) {
      this.mark(id, "archive");
      return true;
    }
    if (matchesKey(data, "d")) {
      this.mark(id, "delete");
      return true;
    }
    if (matchesKey(data, "u")) {
      this.withdraw(id);
      return true;
    }
    return false;
  }
}
