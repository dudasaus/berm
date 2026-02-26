import { createRoute } from "@tanstack/react-router";

import { TerminalView } from "../components/terminal/terminal-view";
import { rootRoute } from "./__root";

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: TerminalView,
});
