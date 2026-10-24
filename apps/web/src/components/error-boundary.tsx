import { Component, type ReactNode } from "react";
import { Button } from "./ui/button.js";
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main id="main-content" tabIndex={-1} className="mx-auto max-w-lg p-8">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p role="alert" className="my-4">
            We couldn’t display this page. Please reload and try again.
          </p>
          <Button onClick={() => window.location.reload()}>Reload page</Button>
        </main>
      );
    return this.props.children;
  }
}
