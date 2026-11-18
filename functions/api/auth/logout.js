// functions/api/auth/logout.js
// Clears the session cookie and redirects to the home page (sign-in screen).

import { originFor } from '../../_lib/hosts.js';

export async function onRequestGet({ request }) {
    const headers = new Headers({ Location: originFor(request) + '/' });
    headers.append(
          'Set-Cookie',
          'radar_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
        );
    return new Response(null, { status: 302, headers });
}
