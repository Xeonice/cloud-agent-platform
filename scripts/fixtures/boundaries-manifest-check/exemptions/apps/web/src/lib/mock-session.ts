export async function signIn(password: string) {
  const res = await fetch("https://example.invalid/auth/password", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  return res.ok;
}

export async function signOut() {
  await fetch("https://example.invalid/auth/logout", { method: "POST" });
}
