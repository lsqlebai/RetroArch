package com.retroarch.browser.preferences.util;

import android.content.Context;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public final class CloudGameManager
{
	private CloudGameManager()
	{
	}

	public static List<CloudGame> fetchGames(Context ctx) throws Exception
	{
		URL url = new URL(CloudAuthManager.getServerUrl(ctx) + "/games");
		HttpURLConnection conn = (HttpURLConnection)url.openConnection();
		conn.setRequestMethod("GET");
		conn.setConnectTimeout(10000);
		conn.setReadTimeout(15000);
		conn.setRequestProperty("Accept", "application/json");
		CloudAuthManager.applyCookie(ctx, conn);

		try
		{
			String body = readString(conn.getInputStream());
			if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300)
				throw new IOException("HTTP " + conn.getResponseCode());

			JSONArray array = new JSONArray(body);
			ArrayList<CloudGame> games = new ArrayList<CloudGame>();
			for (int i = 0; i < array.length(); i++)
			{
				JSONObject item = array.getJSONObject(i);
				games.add(new CloudGame(
						item.optString("gameId"),
						item.optString("title", item.optString("fileName", "Game")),
						item.optString("fileName"),
						item.optString("contentUrl"),
						item.optString("contentHash"),
						item.optLong("contentSize", 0)));
			}
			return games;
		}
		finally
		{
			conn.disconnect();
		}
	}

	public static File downloadGame(Context ctx, CloudGame game) throws Exception
	{
		return prepareGame(ctx, game).file;
	}

	public static PreparedGame prepareGame(Context ctx, CloudGame game) throws Exception
	{
		File output = getLocalGameFile(ctx, game);
		if (output.isFile())
		{
			CloudAuthManager.mapGamePath(ctx, output.getAbsolutePath(), game.gameId);
			return new PreparedGame(output, false);
		}

		if (TextUtils.isEmpty(game.contentUrl))
			throw new IOException("missing contentUrl");

		URL url = new URL(resolveContentUrl(CloudAuthManager.getServerUrl(ctx), game.contentUrl));
		HttpURLConnection conn = (HttpURLConnection)url.openConnection();
		conn.setRequestMethod("GET");
		conn.setConnectTimeout(10000);
		conn.setReadTimeout(60000);
		File tempOutput = new File(output.getAbsolutePath() + ".download");

		try
		{
			if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300)
				throw new IOException("HTTP " + conn.getResponseCode());

			InputStream in = conn.getInputStream();
			FileOutputStream out = new FileOutputStream(tempOutput);
			byte[] buffer = new byte[64 * 1024];
			try
			{
				int read;
				while ((read = in.read(buffer)) != -1)
					out.write(buffer, 0, read);
			}
			finally
			{
				in.close();
				out.close();
			}

			if (output.exists() && !output.delete())
				throw new IOException("failed to replace " + output);
			if (!tempOutput.renameTo(output))
				throw new IOException("failed to save " + output);

			CloudAuthManager.mapGamePath(ctx, output.getAbsolutePath(), game.gameId);
			return new PreparedGame(output, true);
		}
		finally
		{
			conn.disconnect();
			if (tempOutput.exists() && !output.exists())
				tempOutput.delete();
		}
	}

	public static File getLocalGameFile(Context ctx, CloudGame game) throws IOException
	{
		File baseDir = ctx.getExternalFilesDir(null);
		if (baseDir == null)
			baseDir = ctx.getFilesDir();

		File dir = new File(baseDir, "cloud-games");
		if (!dir.mkdirs() && !dir.isDirectory())
			throw new IOException("failed to create " + dir);

		return new File(dir, safeFileName(game.fileName));
	}

	private static String resolveContentUrl(String serverUrl, String contentUrl) throws Exception
	{
		URL base = new URL(serverUrl);
		if (contentUrl.startsWith("http://") || contentUrl.startsWith("https://"))
			return contentUrl;
		if (contentUrl.startsWith("/"))
			return base.getProtocol() + "://" + base.getAuthority() + contentUrl;
		return base.getProtocol() + "://" + base.getAuthority() + "/" + contentUrl;
	}

	private static String safeFileName(String fileName)
	{
		if (TextUtils.isEmpty(fileName))
			return "game.zip";
		return fileName.replaceAll("[/\\\\:]", "_");
	}

	private static String readString(InputStream in) throws IOException
	{
		StringBuilder builder = new StringBuilder();
		byte[] buffer = new byte[8192];
		try
		{
			int read;
			while ((read = in.read(buffer)) != -1)
				builder.append(new String(buffer, 0, read, "UTF-8"));
		}
		finally
		{
			in.close();
		}
		return builder.toString();
	}

	public static final class CloudGame
	{
		public final String gameId;
		public final String title;
		public final String fileName;
		public final String contentUrl;
		public final String contentHash;
		public final long contentSize;

		public CloudGame(String gameId, String title, String fileName,
				String contentUrl, String contentHash, long contentSize)
		{
			this.gameId = gameId;
			this.title = title;
			this.fileName = fileName;
			this.contentUrl = contentUrl;
			this.contentHash = contentHash;
			this.contentSize = contentSize;
		}

		@Override
		public String toString()
		{
			String name = !TextUtils.isEmpty(fileName) ? fileName : title;
			if (TextUtils.isEmpty(name))
				name = "Game";

			int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
			if (slash >= 0)
				name = name.substring(slash + 1);

			int dot = name.lastIndexOf('.');
			if (dot > 0)
				name = name.substring(0, dot);

			String hash = !TextUtils.isEmpty(contentHash) ? contentHash : gameId;
			if (TextUtils.isEmpty(hash))
				return name;
			if (hash.startsWith("sha256:") && hash.length() > 19)
				hash = hash.substring(0, 19);
			else if (hash.length() > 19)
				hash = hash.substring(0, 19);
			return name + "-" + hash;
		}
	}

	public static final class PreparedGame
	{
		public final File file;
		public final boolean downloaded;

		public PreparedGame(File file, boolean downloaded)
		{
			this.file = file;
			this.downloaded = downloaded;
		}
	}
}
