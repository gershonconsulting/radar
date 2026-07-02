// functions/api/auth/logout.js
// Clears the session cookie and redirects to the home page (sign-in screen).

export async function onRequestGet() {
    const headers = new Headers({ Location: 'https://radar.gershoncrm.com/' });
    headers.append(
          'Set-Cookie',
          'radar_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
        );
    return new Response(null, { status: 302, headers });
}
