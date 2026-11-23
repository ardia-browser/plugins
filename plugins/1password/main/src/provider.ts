import type { CredentialProvider } from "@ardia/plugin-sdk/credentials";
import { connect, providerState, signOut } from "./accounts";
import { editItem } from "./edits";
import { listItems, reveal } from "./items";
import { saveLogin } from "./saving";

export const onePassword: CredentialProvider = {
  state: (_request, ctx) => providerState(ctx),
  signIn: (request, ctx) => connect(ctx, request.account, "signedOut"),
  unlock: (_request, ctx) => connect(ctx, undefined, "locked"),
  signOut: (_request, ctx) => signOut(ctx),
  list: (_request, ctx) => listItems(ctx),
  reveal: (request, ctx) => reveal(ctx, request),
  save: ({ login }, ctx) => saveLogin(ctx, login),
  edit: ({ id, change }, ctx) => editItem(ctx, id, change),
};
