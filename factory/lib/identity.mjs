export const validAppLogin = (value) => typeof value === "string" && /^[a-z\d][a-z\d-]{0,99}\[bot\]$/.test(value);
export const validFactoryApp = (value) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => ["id", "login"].includes(key))
  && typeof value.id === "string" && /^[1-9]\d*$/.test(value.id) && validAppLogin(value.login);

export function factoryReadApi(api, appLogin) {
  if (appLogin === undefined) return api;
  if (!validAppLogin(appLogin) || api.factoryAppLogin && api.factoryAppLogin !== appLogin) throw new Error("Factory App identity is invalid or changed");
  return Object.assign(Object.create(api), { factoryAppLogin: appLogin });
}
