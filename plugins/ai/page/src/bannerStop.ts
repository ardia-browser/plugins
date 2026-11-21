export type StopDispatch = (reason: string) => void;

export const BANNER_STOP_REASON = "Stopped from the tab";

export function bannerStopper(dispatch: StopDispatch): (stopped: boolean) => void {
  let handled = false;
  return (stopped) => {
    if (!stopped) {
      handled = false;
      return;
    }
    if (handled) return;
    handled = true;
    dispatch(BANNER_STOP_REASON);
  };
}
