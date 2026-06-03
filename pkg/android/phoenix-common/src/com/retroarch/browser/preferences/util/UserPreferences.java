package com.retroarch.browser.preferences.util;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import android.annotation.TargetApi;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.preference.PreferenceManager;
import android.content.pm.PackageManager.NameNotFoundException;
import android.util.Log;

/**
 * Utility class for retrieving, saving, or loading preferences.
 */
public final class UserPreferences
{
	// Logging tag.
	private static final String TAG = "UserPreferences";
	private static final String CLOUD_SYNC_MIGRATION_KEY = "android_cloud_sync_migration_version";
	private static final int CLOUD_SYNC_MIGRATION_VERSION = 3;

	// Disallow explicit instantiation.
	private UserPreferences()
	{
	}

	/**
	 * Retrieves the path to the default location of the libretro config.
	 * 
	 * @param ctx the current {@link Context}
	 * 
	 * @return the path to the default location of the libretro config.
	 */
	public static String getDefaultConfigPath(Context ctx)
	{
		// Internal/External storage dirs.
		final String internal = ctx.getFilesDir().getAbsolutePath();
		String external = null;

		// Get the App's external storage folder
		final String state = android.os.Environment.getExternalStorageState();
		if (android.os.Environment.MEDIA_MOUNTED.equals(state)) {
			File extsd = ctx.getExternalFilesDir(null);
			external = extsd.getAbsolutePath();
		}

		// Native library directory and data directory for this front-end.
		final String dataDir = ctx.getApplicationInfo().dataDir;
		final String coreDir = dataDir + "/cores/";

		// Get libretro name and path
		final SharedPreferences prefs = getPreferences(ctx);
		final String libretro_path = prefs.getString("libretro_path", coreDir);

		// Check if global config is being used. Return true upon failure.
		final boolean globalConfigEnabled = prefs.getBoolean("global_config_enable", true);

		String append_path;
		// If we aren't using the global config.
		if (!globalConfigEnabled && !libretro_path.equals(coreDir))
		{
			String sanitized_name = sanitizeLibretroPath(libretro_path);
			append_path = File.separator + sanitized_name + ".cfg";
		}
		else // Using global config.
		{
			append_path = File.separator + "retroarch.cfg";
		}

		if (external != null)
		{
			String confPath = external + append_path;
			if (new File(confPath).exists())
				return confPath;
		}
		else if (internal != null)
		{
			String confPath = internal + append_path;
			if (new File(confPath).exists())
				return confPath;
		}
		else
		{
			String confPath = "/mnt/extsd" + append_path;
			if (new File(confPath).exists())
				return confPath;
		}

		// Config file does not exist. Create empty one.

		// emergency fallback
		String new_path = "/mnt/sd" + append_path;

		if (external != null)
			new_path = external + append_path;
		else if (internal != null)
			new_path = internal + append_path;
		else if (dataDir != null)
			new_path = dataDir + append_path;

		try {
			new File(new_path).createNewFile();
		}
		catch (IOException e)
		{
			Log.e(TAG, "Failed to create config file to: " + new_path);
		}
		return new_path;
	}

	/**
	 * Updates the libretro configuration file
	 * with new values if version has changed.
	 * 
	 * @param ctx the current {@link Context}.
	 */
	public static void updateConfigFile(Context ctx)
	{
		String path = getDefaultConfigPath(ctx);
		ConfigFile config = new ConfigFile(path);

		final String dataDir = ctx.getApplicationInfo().dataDir;
		final String coreDir = dataDir + "/cores/";
		final String dstPath	= dataDir;
		final String dstPathSubdir = "assets";
		final String assetsPath = dstPath + File.separator + dstPathSubdir;

		final SharedPreferences prefs = getPreferences(ctx);

		config.setString("libretro_directory", coreDir);

		int samplingRate = getOptimalSamplingRate(ctx);
		if (samplingRate != -1) {
			config.setInt("audio_out_rate", samplingRate);
		}

		try
		{
			int version      = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode;
			int last_version = config.keyExists("bundle_assets_extract_last_version") ?
					config.getInt("bundle_assets_extract_last_version") : 0;
			boolean assetsReady = bundledAssetsReady(assetsPath);

			config.setString("bundle_assets_src_path", ctx.getApplicationInfo().sourceDir);
			config.setString("bundle_assets_dst_path", dstPath);
			config.setString("bundle_assets_dst_path_subdir", dstPathSubdir);
			config.setInt("bundle_assets_extract_version_current", version);

			if (!assetsReady || version != last_version)
			{
				if (extractBundledAssets(ctx.getApplicationInfo().sourceDir, assetsPath))
				{
					config.setInt("bundle_assets_extract_last_version", version);
					config.setBoolean("bundle_assets_extract_enable", false);
				}
				else
				{
					config.setInt("bundle_assets_extract_last_version", 0);
					config.setBoolean("bundle_assets_extract_enable", true);
				}
			}
		}
		catch (NameNotFoundException ignored)
		{
		}

			File appExternalDir = ctx.getExternalFilesDir(null);
			String cloudBaseDir = appExternalDir != null
					? appExternalDir.getAbsolutePath()
					: ctx.getFilesDir().getAbsolutePath();
			String cloudSaveDir = cloudBaseDir + File.separator + "saves";
			String cloudStateDir = cloudBaseDir + File.separator + "states";
			String cloudDownloadDir = cloudBaseDir + File.separator + "downloads";
			new File(cloudSaveDir).mkdirs();
			new File(cloudStateDir).mkdirs();
			new File(cloudDownloadDir).mkdirs();

			int cloudSyncMigrationVersion = config.keyExists(CLOUD_SYNC_MIGRATION_KEY) ?
					config.getInt(CLOUD_SYNC_MIGRATION_KEY) : 0;
		String overlayDir = assetsPath + File.separator + "overlays";
		String defaultOverlay = overlayDir + File.separator + "gamepads"
				+ File.separator + "neo-retropad" + File.separator + "neo-retropad.cfg";
		String oskOverlayDir = overlayDir + File.separator + "keyboards";
		String defaultOskOverlay = oskOverlayDir + File.separator + "US-101"
				+ File.separator + "US-101.cfg";

		if (cloudSyncMigrationVersion < CLOUD_SYNC_MIGRATION_VERSION)
		{
			config.setString("cloud_sync_driver", "retroarch_sync");
			config.setBoolean("cloud_sync_enable", true);
			config.setInt("cloud_sync_sync_mode", 1);
			config.setBoolean("cloud_sync_sync_saves", true);
			config.setBoolean("cloud_sync_sync_configs", false);
				config.setBoolean("cloud_sync_sync_thumbs", false);
				config.setBoolean("cloud_sync_sync_system", false);
				config.setString("savefile_directory", cloudSaveDir);
				config.setString("savestate_directory", cloudStateDir);
				config.setString("core_assets_directory", cloudDownloadDir);
				config.setBoolean("input_overlay_enable", true);
				config.setString("overlay_directory", overlayDir);
			config.setString("input_overlay", defaultOverlay);
			config.setString("osk_overlay_directory", oskOverlayDir);
			config.setString("input_osk_overlay", defaultOskOverlay);
			config.setBoolean("input_overlay_hide_in_menu", true);
			config.setBoolean("input_overlay_hide_when_gamepad_connected", false);
			config.setInt(CLOUD_SYNC_MIGRATION_KEY, CLOUD_SYNC_MIGRATION_VERSION);
		}
		else
		{
			if (!config.keyExists("cloud_sync_driver")
					|| "null".equals(config.getString("cloud_sync_driver")))
				config.setString("cloud_sync_driver", "retroarch_sync");
			if (!config.keyExists("cloud_sync_enable"))
				config.setBoolean("cloud_sync_enable", true);
			if (!config.keyExists("cloud_sync_sync_mode"))
				config.setInt("cloud_sync_sync_mode", 1);
			if (!config.keyExists("cloud_sync_sync_saves"))
				config.setBoolean("cloud_sync_sync_saves", true);
			if (!config.keyExists("cloud_sync_sync_configs"))
				config.setBoolean("cloud_sync_sync_configs", false);
			if (!config.keyExists("cloud_sync_sync_thumbs"))
				config.setBoolean("cloud_sync_sync_thumbs", false);
				if (!config.keyExists("cloud_sync_sync_system"))
					config.setBoolean("cloud_sync_sync_system", false);
				if (!config.keyExists("savefile_directory"))
					config.setString("savefile_directory", cloudSaveDir);
				if (!config.keyExists("savestate_directory"))
					config.setString("savestate_directory", cloudStateDir);
				if (!config.keyExists("core_assets_directory"))
					config.setString("core_assets_directory", cloudDownloadDir);
				if (!config.keyExists("overlay_directory"))
				config.setString("overlay_directory", overlayDir);
			if (!config.keyExists("input_overlay"))
				config.setString("input_overlay", defaultOverlay);
			if (!config.keyExists("osk_overlay_directory"))
				config.setString("osk_overlay_directory", oskOverlayDir);
			if (!config.keyExists("input_osk_overlay"))
				config.setString("input_osk_overlay", defaultOskOverlay);
		}
		config.setString("webdav_url", prefs.getString(CloudAuthManager.PREF_SERVER_URL,
				CloudAuthManager.getServerUrl(ctx)));
		config.setString("webdav_username", prefs.getString(CloudAuthManager.PREF_USERNAME, ""));

		// Refactor this entire mess and make this usable for per-core config
		if (Build.VERSION.SDK_INT >= 17 && prefs.getBoolean("audio_latency_auto", true))
		{
			int bufferSize = getLowLatencyBufferSize(ctx);
			if (bufferSize != -1) {
				config.setInt("audio_block_frames", bufferSize);
			}
		}

		try
		{
			Log.i(TAG, "Writing config to: " + path);
			Log.i(TAG, "dst dir is: " + dstPath);
			Log.i(TAG, "dst subdir is: " + dstPathSubdir);
			config.write(path);
		}
		catch (IOException e)
		{
			Log.e(TAG, "Failed to save config file to: " + path);
		}
	}

	private static boolean bundledAssetsReady(String assetsPath)
	{
		return new File(assetsPath, "pkg/chinese-fallback-font.ttf").isFile()
				&& new File(assetsPath, "glui/main_tab_passive.png").isFile()
				&& new File(assetsPath, "glui/font.ttf").isFile();
	}

	private static boolean extractBundledAssets(String apkPath, String assetsPath)
	{
		File assetsDir = new File(assetsPath);
		byte[] buffer = new byte[1024 * 64];

		Log.i(TAG, "Extracting bundled assets from: " + apkPath);
		deleteRecursively(assetsDir);

		if (!assetsDir.mkdirs() && !assetsDir.isDirectory())
		{
			Log.e(TAG, "Failed to create assets directory: " + assetsPath);
			return false;
		}

		try (ZipInputStream zip = new ZipInputStream(new FileInputStream(apkPath)))
		{
			ZipEntry entry;

			while ((entry = zip.getNextEntry()) != null)
			{
				String name = entry.getName();

				if (!name.startsWith("assets/"))
					continue;

				String relative = name.substring("assets/".length());
				if (relative.length() == 0)
					continue;

				File output = new File(assetsDir, relative);

				if (entry.isDirectory())
				{
					if (!output.mkdirs() && !output.isDirectory())
						throw new IOException("Failed to create directory: " + output);
				}
				else
				{
					File parent = output.getParentFile();
					if (parent != null && !parent.mkdirs() && !parent.isDirectory())
						throw new IOException("Failed to create directory: " + parent);

					try (FileOutputStream out = new FileOutputStream(output))
					{
						int read;
						while ((read = zip.read(buffer)) != -1)
							out.write(buffer, 0, read);
					}
				}

				zip.closeEntry();
			}
		}
		catch (IOException e)
		{
			Log.e(TAG, "Failed to extract bundled assets.", e);
			return false;
		}

		boolean ready = bundledAssetsReady(assetsPath);
		Log.i(TAG, "Bundled assets ready: " + ready);
		return ready;
	}

	private static void deleteRecursively(File file)
	{
		if (file == null || !file.exists())
			return;

		if (file.isDirectory())
		{
			File[] children = file.listFiles();
			if (children != null)
				for (File child : children)
					deleteRecursively(child);
		}

		if (!file.delete())
			Log.w(TAG, "Failed to delete: " + file);
	}

	private static void readbackString(ConfigFile cfg, SharedPreferences.Editor edit, String key)
	{
		if (cfg.keyExists(key))
			edit.putString(key, cfg.getString(key));
		else
			edit.remove(key);
	}

	private static void readbackBool(ConfigFile cfg, SharedPreferences.Editor edit, String key)
	{
		if (cfg.keyExists(key))
			edit.putBoolean(key, cfg.getBoolean(key));
		else
			edit.remove(key);
	}

	private static void readbackDouble(ConfigFile cfg, SharedPreferences.Editor edit, String key)
	{
		if (cfg.keyExists(key))
			edit.putFloat(key, (float)cfg.getDouble(key));
		else
			edit.remove(key);
	}

	/*
	private static void readbackFloat(ConfigFile cfg, SharedPreferences.Editor edit, String key)
	{
		if (cfg.keyExists(key))
			edit.putFloat(key, cfg.getFloat(key));
		else
			edit.remove(key);
	}
	*/

	/**
	private static void readbackInt(ConfigFile cfg, SharedPreferences.Editor edit, String key)
	{
		if (cfg.keyExists(key))
			edit.putInt(key, cfg.getInt(key));
		else
			edit.remove(key);
	}
	*/

	/**
	 * Sanitizes a libretro core path.
	 * 
	 * @param path The path to the libretro core.
	 * 
	 * @return the sanitized libretro path.
	 */
	private static String sanitizeLibretroPath(String path)
	{
		String sanitized_name = path.substring(
				path.lastIndexOf('/') + 1,
				path.lastIndexOf('.'));
		sanitized_name = sanitized_name.replace("neon", "");
		sanitized_name = sanitized_name.replace("libretro_", "");

		return sanitized_name;
	}

	/**
	 * Gets a {@link SharedPreferences} instance containing current settings.
	 * 
	 * @param ctx the current {@link Context}.
	 * 
	 * @return A SharedPreference instance containing current settings.
	 */
	public static SharedPreferences getPreferences(Context ctx)
	{
		return PreferenceManager.getDefaultSharedPreferences(ctx);
	}

	/**
	 * Gets the optimal sampling rate for low-latency audio playback.
	 * 
	 * @param ctx the current {@link Context}.
	 * 
	 * @return the optimal sampling rate for low-latency audio playback in Hz.
	 */
	@TargetApi(17)
	private static int getLowLatencyOptimalSamplingRate(Context ctx)
	{
		AudioManager manager = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
		String value = manager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);

		if(value == null || value.isEmpty()) {
			return -1;
		}

		return Integer.parseInt(value);
	}

	/**
	 * Gets the optimal buffer size for low-latency audio playback.
	 * 
	 * @param ctx the current {@link Context}.
	 * 
	 * @return the optimal output buffer size in decimal PCM frames.
	 */
	@TargetApi(17)
	private static int getLowLatencyBufferSize(Context ctx)
	{
		AudioManager manager = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
		String value = manager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER);

		if(value == null || value.isEmpty()) {
			return -1;
		}

		int buffersize = Integer.parseInt(value);
		Log.i(TAG, "Queried ideal buffer size (frames): " + buffersize);
		return buffersize;
	}

	/**
	 * Gets the optimal audio sampling rate.
	 * <p>
	 * On Android 4.2+ devices this will retrieve the optimal low-latency sampling rate,
	 * since Android 4.2 adds support for low latency audio in general.
	 * <p>
	 * On other devices, it simply returns the regular optimal sampling rate
	 * as returned by the hardware.
	 * 
	 * @param ctx The current {@link Context}.
	 * 
	 * @return the optimal audio sampling rate in Hz.
	 */
	private static int getOptimalSamplingRate(Context ctx)
	{
		int ret;
		if (Build.VERSION.SDK_INT >= 17)
			ret = getLowLatencyOptimalSamplingRate(ctx);
		else
			ret = AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC);

		Log.i(TAG, "Using sampling rate: " + ret + " Hz");
		return ret;
	}
}
