import "./core.ts";
import "./read.ts";
import "./read-page.ts";
import "./find.ts";
import "./storage.ts";
import "./act.ts";
import "./batch.ts";
import "../act/react.ts";
import "../act/install.ts";
import "../capture/install.ts";
import { findAct } from "../act/find-act.ts";
import { findActions } from "./find.ts";

findActions.act = findAct;

export { dispatch, hooks, OWNERS, register, served } from "./index.ts";
