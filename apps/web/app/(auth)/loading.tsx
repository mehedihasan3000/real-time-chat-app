import { StatePanel } from "@/components/ui/state-panel";

export default function AuthLoading() {
  return (
    <StatePanel
      kind="loading"
      title="Loading account screen"
      description="The account surface is rendering. No credentials are sent by this preview."
      live
    />
  );
}
