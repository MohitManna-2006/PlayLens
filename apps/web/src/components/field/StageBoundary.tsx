"use client";

import { Component, type ReactNode } from "react";
import { StatusState } from "@/components/ui/StatusState";

/**
 * If the field renderer throws, keep the page usable: metadata, the dock, and
 * the frame data table remain, and the stage offers Retry replay (§7).
 */
export class StageBoundary extends Component<{ children: ReactNode }, { error: string | null; attempt: number }> {
  state = { error: null as string | null, attempt: 0 };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : "The field renderer failed." };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full bg-surface p-6">
          <StatusState
            kind="error"
            title="The field could not be drawn"
            action={
              <button type="button" className="btn" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>
                Retry replay
              </button>
            }
          >
            {this.state.error} Player positions remain available in the frame data table below.
          </StatusState>
        </div>
      );
    }
    return <div key={this.state.attempt} className="h-full w-full">{this.props.children}</div>;
  }
}
