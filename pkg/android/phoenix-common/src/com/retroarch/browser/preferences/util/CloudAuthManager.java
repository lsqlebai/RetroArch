package com.retroarch.browser.preferences.util;

import android.content.Context;
import android.content.SharedPreferences;
import android.preference.PreferenceManager;
import android.text.TextUtils;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public final class CloudAuthManager
{
	public static final String PREF_SERVER_URL = "cloud_sync_server_url";
	public static final String PREF_USERNAME = "cloud_sync_username";
	public static final String PREF_SESSION_COOKIE = "cloud_sync_session_cookie";
	public static final String PREF_SESSION_EXPIRES_AT = "cloud_sync_session_expires_at";
	public static final String PREF_GAME_ID = "cloud_sync_game_id";
	public static final String PREF_GAME_PATH_PREFIX = "cloud_sync_game_path_";

	private static final String DEFAULT_SERVER_URL = "http://10.0.2.2:8080/api/sync/v1";
	private static final String DEFAULT_GAME_ID = "default";
	private static final String SESSION_COOKIE_NAME = "retroarch_session";

	private CloudAuthManager()
	{
	}

	public static SharedPreferences getPreferences(Context ctx)
	{
		return PreferenceManager.getDefaultSharedPreferences(ctx);
	}

	public static String getServerUrl(Context ctx)
	{
		String value = getPreferences(ctx).getString(PREF_SERVER_URL, DEFAULT_SERVER_URL);
		if (TextUtils.isEmpty(value))
			return DEFAULT_SERVER_URL;
		return trimTrailingSlash(value.trim());
	}

	public static String getUsername(Context ctx)
	{
		return getPreferences(ctx).getString(PREF_USERNAME, "");
	}

	public static String getGameId(Context ctx)
	{
		String value = getPreferences(ctx).getString(PREF_GAME_ID, DEFAULT_GAME_ID);
		if (TextUtils.isEmpty(value))
			return DEFAULT_GAME_ID;
		return value.trim();
	}

	public static String getGameIdForContent(Context ctx, String contentPath)
	{
		if (TextUtils.isEmpty(contentPath))
			return getGameId(ctx);

		String value = getPreferences(ctx).getString(
				PREF_GAME_PATH_PREFIX + contentPath, "");
		if (TextUtils.isEmpty(value))
			return getGameId(ctx);
		return value;
	}

	public static boolean isLoggedIn(Context ctx)
	{
		return !TextUtils.isEmpty(getSessionCookie(ctx));
	}

	public static String getCookieHeader(Context ctx)
	{
		String cookie = getSessionCookie(ctx);
		if (TextUtils.isEmpty(cookie))
			return "";
		return "Cookie: " + cookie + "\r\n";
	}

	public static void applyCookie(Context ctx, HttpURLConnection conn)
	{
		String cookie = getSessionCookie(ctx);
		if (!TextUtils.isEmpty(cookie))
			conn.setRequestProperty("Cookie", cookie);
	}

	public static void setGameId(Context ctx, String gameId)
	{
		getPreferences(ctx).edit().putString(PREF_GAME_ID, gameId).apply();
	}

	public static void mapGamePath(Context ctx, String contentPath, String gameId)
	{
		if (TextUtils.isEmpty(contentPath) || TextUtils.isEmpty(gameId))
			return;
		getPreferences(ctx).edit()
				.putString(PREF_GAME_PATH_PREFIX + contentPath, gameId)
				.putString(PREF_GAME_ID, gameId)
				.apply();
	}

	public static AuthResult login(Context ctx, String serverUrl, String username, String password)
			throws IOException
	{
		return auth(ctx, serverUrl, "auth/login", username, password);
	}

	public static AuthResult register(Context ctx, String serverUrl, String username, String password)
			throws IOException
	{
		return auth(ctx, serverUrl, "auth/register", username, password);
	}

	public static AuthResult me(Context ctx) throws IOException
	{
		HttpURLConnection conn = open(ctx, getServerUrl(ctx), "auth/me", "GET");
		try
		{
			String body = readResponse(conn);
			if (conn.getResponseCode() >= 200 && conn.getResponseCode() < 300)
				return new AuthResult(true, getUsername(ctx), body);

			if (conn.getResponseCode() == HttpURLConnection.HTTP_UNAUTHORIZED)
				clear(ctx);
			return new AuthResult(false, "", body);
		}
		finally
		{
			conn.disconnect();
		}
	}

	public static void logout(Context ctx) throws IOException
	{
		HttpURLConnection conn = open(ctx, getServerUrl(ctx), "auth/logout", "POST");
		try
		{
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "application/json");
			writeString(conn, "{}");
			readResponse(conn);
		}
		finally
		{
			conn.disconnect();
			clear(ctx);
		}
	}

	public static void clear(Context ctx)
	{
		getPreferences(ctx).edit()
				.remove(PREF_SESSION_COOKIE)
				.remove(PREF_SESSION_EXPIRES_AT)
				.apply();
	}

	private static AuthResult auth(Context ctx, String serverUrl, String path,
			String username, String password) throws IOException
	{
		serverUrl = trimTrailingSlash(serverUrl);
		HttpURLConnection conn = open(ctx, serverUrl, path, "POST");
		String body = "{\"username\":\"" + jsonEscape(username.trim()) + "\",\"password\":\""
				+ jsonEscape(password) + "\"}";

		try
		{
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "application/json");
			writeString(conn, body);

			String response = readResponse(conn);
			if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300)
				return new AuthResult(false, "", response);

			String sessionCookie = extractSessionCookie(conn.getHeaderField("Set-Cookie"));
			if (TextUtils.isEmpty(sessionCookie))
				return new AuthResult(false, "", "missing session cookie");

			getPreferences(ctx).edit()
					.putString(PREF_SERVER_URL, serverUrl)
					.putString(PREF_USERNAME, username.trim())
					.putString(PREF_SESSION_COOKIE, sessionCookie)
					.apply();
			return new AuthResult(true, username.trim(), response);
		}
		finally
		{
			conn.disconnect();
		}
	}

	private static HttpURLConnection open(Context ctx, String serverUrl, String path, String method)
			throws IOException
	{
		URL url = new URL(trimTrailingSlash(serverUrl) + "/" + path);
		HttpURLConnection conn = (HttpURLConnection)url.openConnection();
		conn.setRequestMethod(method);
		conn.setConnectTimeout(10000);
		conn.setReadTimeout(15000);
		conn.setRequestProperty("Accept", "application/json");

		String cookie = getSessionCookie(ctx);
		if (!TextUtils.isEmpty(cookie))
			conn.setRequestProperty("Cookie", cookie);

		return conn;
	}

	private static String getSessionCookie(Context ctx)
	{
		return getPreferences(ctx).getString(PREF_SESSION_COOKIE, "");
	}

	private static String extractSessionCookie(String setCookie)
	{
		if (TextUtils.isEmpty(setCookie))
			return "";

		String[] parts = setCookie.split(";");
		for (String part : parts)
		{
			String trimmed = part.trim();
			if (trimmed.startsWith(SESSION_COOKIE_NAME + "="))
				return trimmed;
		}
		return "";
	}

	private static void writeString(HttpURLConnection conn, String value) throws IOException
	{
		OutputStream out = conn.getOutputStream();
		try
		{
			out.write(value.getBytes("UTF-8"));
		}
		finally
		{
			out.close();
		}
	}

	private static String readResponse(HttpURLConnection conn) throws IOException
	{
		InputStream stream = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
		if (stream == null)
			return "";

		BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
		StringBuilder builder = new StringBuilder();
		try
		{
			String line;
			while ((line = reader.readLine()) != null)
				builder.append(line);
		}
		finally
		{
			reader.close();
		}
		return builder.toString();
	}

	private static String trimTrailingSlash(String value)
	{
		while (value.endsWith("/"))
			value = value.substring(0, value.length() - 1);
		return value;
	}

	private static String jsonEscape(String value)
	{
		StringBuilder builder = new StringBuilder();
		for (int i = 0; i < value.length(); i++)
		{
			char c = value.charAt(i);
			switch (c)
			{
				case '\\':
					builder.append("\\\\");
					break;
				case '"':
					builder.append("\\\"");
					break;
				case '\n':
					builder.append("\\n");
					break;
				case '\r':
					builder.append("\\r");
					break;
				case '\t':
					builder.append("\\t");
					break;
				default:
					builder.append(c);
					break;
			}
		}
		return builder.toString();
	}

	public static final class AuthResult
	{
		public final boolean success;
		public final String username;
		public final String message;

		public AuthResult(boolean success, String username, String message)
		{
			this.success = success;
			this.username = username;
			this.message = message;
		}
	}
}
