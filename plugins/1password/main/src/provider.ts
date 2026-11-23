import type { CredentialHandler, CredentialProvider, Item, SealedAddTotpRequest, SealedEditRequest } from "@ardia/plugin-sdk/credentials";
import { connect, providerState, signOut } from "./accounts";
import { editItem } from "./edits";
import { listItems, reveal } from "./items";
import { itemLink } from "./links";
import { saveLogin } from "./saving";

const edit: CredentialHandler<SealedEditRequest, Item> = ({ id, change }, ctx) => editItem(ctx, id, change);
const addTotp: CredentialHandler<SealedAddTotpRequest, Item> = ({ id, uri }, ctx) => editItem(ctx, id, { totp: { set: uri } });

export const onePassword: CredentialProvider = {
  state: (_request, ctx) => providerState(ctx),
  signIn: (request, ctx) => connect(ctx, request.account, "signedOut"),
  unlock: (_request, ctx) => connect(ctx, undefined, "locked"),
  signOut: (_request, ctx) => signOut(ctx),
  list: (_request, ctx) => listItems(ctx),
  reveal: (request, ctx) => reveal(ctx, request),
  save: ({ login }, ctx) => saveLogin(ctx, login),
  edit,
  addTotp,
  link: ({ id }, ctx) => itemLink(ctx, id),
};
