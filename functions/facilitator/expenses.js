/* The facilitator hours report at /facilitator/expenses: the same form as the instructor expense report (expenses.html),
   served under /facilitator so the Facilitator Portal's Access application covers it. */
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  url.pathname = '/expenses';
  return env.ASSETS.fetch(new Request(url.toString(), request));
}
