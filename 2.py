import json
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import undetected_chromedriver as uc
import time
import random
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

class AdvancedAutomatedLoginScript:
    """
    An advanced script for automating website logins with enhanced features
    including fingerprint spoofing, flexible authentication methods, and robust error handling.
    """

    def __init__(self, config_path="config.json"):
        """
        Initializes the script with a configuration file.

        Args:
            config_path (str): Path to the JSON configuration file.
        """
        self.config_path = config_path
        self.config = self.load_config()
        self.driver = None
        self.wait = None
        self.cookies = []
        self.headers = {}

    def load_config(self):
        """
        Loads configuration from a JSON file. Creates a default structure if the file is not found.

        Returns:
            dict: The loaded configuration.
        """
        try:
            with open(self.config_path, 'r') as f:
                config_data = json.load(f)
                logging.info(f"Configuration loaded successfully from {self.config_path}")
                return config_data
        except FileNotFoundError:
            logging.warning(f"Configuration file not found at {self.config_path}. Creating a default configuration.")
            return self._get_default_config()
        except json.JSONDecodeError:
            logging.error(f"Error decoding JSON from {self.config_path}. Please check the file format.")
            return self._get_default_config()

    def _get_default_config(self):
        """
        Provides a default configuration dictionary.

        Returns:
            dict: Default configuration.
        """
        return {
            "login_url": "",
            "authentication_method": "credentials",  # options: cookies, headers, credentials
            "username": "",
            "password": "",
            "username_selector": "",
            "password_selector": "",
            "login_button_selector": "",
            "manual_cookies": [],
            "manual_headers": {},
            "fingerprint_spoofing": {
                "enabled": True,
                "navigator": {
                    "platform": "Win32",
                    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
                    "language": "en-US",
                    "languages": ["en-US", "en"],
                    "webdriver": False,
                    "plugins": [
                        {"name": "Chrome PDF Viewer", "filename": "mhjfbmdlhnkhlgllnjjnhpbnjbigdmjl.pdf"},
                        {"name": "Chromium PDF Viewer", "filename": "khgukdpfpoeabjkaobknalipjnnjbpil.pdf"},
                        {"name": "Native PDF Viewer", "filename": "cmkiofbbfejfnfnlbdhggjchfokcpepi.pdf"}
                    ],
                    "platformSubtype": "x64"
                },
                "screen": {
                    "width": 1920,
                    "height": 1080,
                    "colorDepth": 24,
                    "pixelRatio": 1.0
                },
                "hardwareConcurrency": 8,
                "deviceMemory": 8,
                "maxTouchPoints": 0,
                "vendor": "Google Inc.",
                "vendorSub": "",
                "renderer": "Intel Iris OpenGL Engine"
            },
            "wait_timeout": 15, # Increased default wait timeout
            "random_delay_range": [0.5, 2.0] # More flexible random delay range
        }

    def save_config(self):
        """
        Saves the current configuration to the JSON file.
        """
        try:
            with open(self.config_path, 'w') as f:
                json.dump(self.config, f, indent=4)
            logging.info(f"Configuration saved to {self.config_path}")
        except IOError as e:
            logging.error(f"Error saving configuration to {self.config_path}: {e}")

    def configure_driver(self):
        """
        Configures and initializes the Selenium WebDriver with specified options,
        including fingerprint spoofing.
        """
        options = uc.ChromeOptions()

        # Apply user-agent from config or default
        user_agent = self.config.get("fingerprint_spoofing", {}).get("navigator", {}).get("userAgent", self._get_default_config()["fingerprint_spoofing"]["navigator"]["userAgent"])
        options.add_argument(f"--user-agent={user_agent}")

        # Disable automation flags for better evasion
        options.add_experimental_option('excludeSwitches', ['enable-automation'])
        options.add_experimental_option('useAutomationExtension', False)

        # Spoofing via JavaScript
        if self.config.get("fingerprint_spoofing", {}).get("enabled", False):
            fp_config = self.config["fingerprint_spoofing"]
            navigator_settings = fp_config.get("navigator", {})
            screen_settings = fp_config.get("screen", {})

            # Inject custom navigator properties
            navigator_js_vars = {
                "platform": navigator_settings.get("platform", "Win32"),
                "language": navigator_settings.get("language", "en-US"),
                "languages": json.dumps(navigator_settings.get("languages", ["en-US", "en"])),
                "webdriver": navigator_settings.get("webdriver", False),
                "platformSubtype": navigator_settings.get("platformSubtype", "x64"),
                "hardwareConcurrency": fp_config.get("hardwareConcurrency", 8),
                "deviceMemory": fp_config.get("deviceMemory", 8),
                "maxTouchPoints": fp_config.get("maxTouchPoints", 0),
                "vendor": fp_config.get("vendor", "Google Inc."),
                "vendorSub": fp_config.get("vendorSub", ""),
                "renderer": fp_config.get("renderer", "Intel Iris OpenGL Engine")
            }

            # Spoofing plugins
            mock_plugins = navigator_settings.get("plugins", [])
            plugin_definitions = []
            for i, plugin in enumerate(mock_plugins):
                plugin_definitions.append(f"""
                    {i}: {{
                        name: '{plugin.get('name', '')}',
                        filename: '{plugin.get('filename', '')}',
                        description: '{plugin.get('name', '')}' // Often description is same as name for mock
                    }}
                """)
            plugins_js = "{\n" + ",\n".join(plugin_definitions) + "\n}" if plugin_definitions else "{}"

            navigator_js_code = f"""
            Object.defineProperty(navigator, 'platform', {{ get: () => '{navigator_js_vars['platform']}' }});
            Object.defineProperty(navigator, 'language', {{ get: () => '{navigator_js_vars['language']}' }});
            Object.defineProperty(navigator, 'languages', {{ get: () => {navigator_js_vars['languages']} }});
            Object.defineProperty(navigator, 'webdriver', {{ get: () => {navigator_js_vars['webdriver']} }});
            Object.defineProperty(navigator, 'platformSubtype', {{ get: () => '{navigator_js_vars['platformSubtype']}' }});
            Object.defineProperty(navigator, 'plugins', {{ get: () => {{ length: {len(mock_plugins)}, item: function(index) {{ return this[index]; }} }} }} );
            Object.defineProperty(navigator.plugins, 'length', {{ value: {len(mock_plugins)} }});
            {', '.join([f"Object.defineProperty(navigator.plugins, {i}, {{ value: {{ name: \'{p.get('name', '')}\', filename: \'{p.get('filename', '')}\', description: \'{p.get('name', '')}\' }} }});" for i, p in enumerate(mock_plugins)])}

            Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {navigator_js_vars['hardwareConcurrency']} }});
            Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {navigator_js_vars['deviceMemory']} }});
            Object.defineProperty(navigator, 'maxTouchPoints', {{ get: () => {navigator_js_vars['maxTouchPoints']} }});
            Object.defineProperty(navigator, 'vendor', {{ get: () => '{navigator_js_vars['vendor']}' }});
            Object.defineProperty(navigator, 'vendorSub', {{ get: () => '{navigator_js_vars['vendorSub']}' }});
            Object.defineProperty(navigator, 'renderer', {{ get: () => '{navigator_js_vars['renderer']}' }});
            """
            self.driver.execute_script(navigator_js_code)

            # Inject custom screen properties
            screen_js_code = f"""
            Object.defineProperty(window.screen, 'width', {{ get: () => {screen_settings.get("width", 1920)} }});
            Object.defineProperty(window.screen, 'height', {{ get: () => {screen_settings.get("height", 1080)} }});
            Object.defineProperty(window.screen, 'colorDepth', {{ get: () => {screen_settings.get("colorDepth", 24)} }});
            Object.defineProperty(window.screen, 'pixelRatio', {{ get: () => {screen_settings.get("pixelRatio", 1.0)} }});
            """
            self.driver.execute_script(screen_js_code)

        try:
            service = Service(ChromeDriverManager().install())
            self.driver = uc.Chrome(service=service, options=options)
            self.wait = WebDriverWait(self.driver, self.config.get("wait_timeout", 15))
            logging.info("Undetected ChromeDriver initialized successfully.")

            # Set window size based on spoofed screen dimensions
            self.driver.set_window_size(
                screen_settings.get("width", 1920),
                screen_settings.get("height", 1080)
            )
            logging.info(f"Browser window set to {screen_settings.get('width', 1920)}x{screen_settings.get('height', 1080)}.")

        except Exception as e:
            logging.error(f"Error configuring WebDriver: {e}")
            raise

    def apply_cookies(self):
        """
        Applies cookies from the configuration if the authentication method is 'cookies'.
        """
        if self.config.get("authentication_method") == "cookies":
            self.cookies = self.config.get("manual_cookies", [])
            if self.cookies:
                for cookie in self.cookies:
                    # Ensure all required fields are present for add_cookie
                    cookie_to_add = {
                        "name": cookie.get("name"),
                        "value": cookie.get("value"),
                        "domain": cookie.get("domain", ""),
                        "path": cookie.get("path", "/"),
                        "expires": cookie.get("expires"),
                        "httpOnly": cookie.get("httpOnly", False),
                        "secure": cookie.get("secure", False),
                        "sameSite": cookie.get("sameSite", "Lax")
                    }
                    # Filter out None values for optional fields like 'expires'
                    cookie_to_add = {k: v for k, v in cookie_to_add.items() if v is not None}
                    self.driver.add_cookie(cookie_to_add)
                logging.info("Manual cookies applied.")
            else:
                logging.warning("No manual cookies found in configuration.")

    def apply_headers(self):
        """
        Handles headers for authentication. Note: Direct header application to an
        active Selenium session is complex and usually requires proxies or
        initial request manipulation. This method logs a warning.
        """
        if self.config.get("authentication_method") == "headers":
            self.headers = self.config.get("manual_headers", {})
            if self.headers:
                logging.warning(
                    "Manual headers found in configuration. Direct header application "
                    "to an active Selenium session is complex and may not be fully "
                    "effective for initial page load. Consider using a proxy or "
                    "manipulating initial requests if headers are critical."
                )
            else:
                logging.warning("No manual headers found in configuration.")

    def _perform_credential_login(self):
        """
        Handles login using username and password credentials.
        """
        username = self.config.get("username")
        password = self.config.get("password")
        username_selector = self.config.get("username_selector")
        password_selector = self.config.get("password_selector")
        login_button_selector = self.config.get("login_button_selector")

        if not all([username, password, username_selector, password_selector, login_button_selector]):
            logging.error("Username, password, or their selectors are not fully configured for credential-based login.")
            return False

        try:
            logging.info("Attempting credential-based login...")
            username_field = self.wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, username_selector)))
            password_field = self.wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, password_selector)))
            login_button = self.wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, login_button_selector)))

            username_field.clear()
            username_field.send_keys(username)
            password_field.clear()
            password_field.send_keys(password)

            # Add a random delay before clicking
            delay = random.uniform(*self.config.get("random_delay_range", [0.5, 2.0]))
            logging.debug(f"Waiting for {delay:.2f} seconds before clicking login button.")
            time.sleep(delay)

            login_button.click()
            logging.info("Login credentials submitted successfully.")
            return True
        except Exception as e:
            logging.error(f"Error during credential-based login: {e}")
            return False

    def perform_login(self):
        """
        Navigates to the login URL and applies the chosen authentication method.

        Returns:
            bool: True if the login process was initiated successfully, False otherwise.
        """
        login_url = self.config.get("login_url")
        auth_method = self.config.get("authentication_method")

        if not login_url:
            logging.error("Login URL is not configured.")
            return False

        try:
            logging.info(f"Navigating to login URL: {login_url}")
            self.driver.get(login_url)

            if auth_method == "cookies":
                self.apply_cookies()
                logging.info("Refreshing page to apply cookies.")
                self.driver.refresh()
                # Add a small wait after refresh to ensure cookies are processed
                time.sleep(self.config.get("random_delay_range", [0.5, 2.0])[0])

            elif auth_method == "headers":
                self.apply_headers()
                # Headers are typically handled before the page load or via proxy.
                # If they are for subsequent requests, this script doesn't directly manage that.
                logging.info("Authentication method set to 'headers'. Proceeding to check for login success.")

            elif auth_method == "credentials":
                if not self._perform_credential_login():
                    return False
            else:
                logging.error(f"Unsupported authentication method: {auth_method}")
                return False

            # A basic check for successful login could involve waiting for a post-login element.
            # This is highly site-specific and requires user configuration.
            # For now, we assume success if no exceptions occurred.
            logging.info(f"Login process initiated for URL: {login_url} with method: {auth_method}")
            return True

        except Exception as e:
            logging.error(f"An error occurred during the login process: {e}")
            return False

    def run(self):
        """
        Executes the complete automated login process.
        """
        try:
            self.configure_driver()
            if self.perform_login():
                logging.info("Automated login script executed successfully.")
                # Keep the browser open for a short duration to observe
                observation_time = self.config.get("observation_time", 5)
                if observation_time > 0:
                    logging.info(f"Keeping browser open for {observation_time} seconds.")
                    time.sleep(observation_time)
            else:
                logging.warning("Automated login script encountered issues during execution.")
        except Exception as e:
            logging.critical(f"An unexpected critical error occurred during script execution: {e}", exc_info=True)
        finally:
            if self.driver:
                self.driver.quit()
                logging.info("Browser closed.")

    def update_config(self, key, value):
        """
        Updates a specific configuration value and saves the configuration.

        Args:
            key (str): The configuration key to update.
            value: The new value for the key.
        """
        if key in self.config:
            self.config[key] = value
            self.save_config()
            logging.info(f"Configuration '{key}' updated to: {value}")
        else:
            logging.warning(f"Configuration key '{key}' not found. Cannot update.")

# --- Example Usage ---
# To run this script:
# 1. Ensure you have Python installed.
# 2. Install necessary libraries:
#    pip install selenium undetected-chromedriver webdriver-manager
# 3. Create a 'config.json' file in the same directory as this script,
#    or rely on the default configuration if the file is missing.
#    Populate 'config.json' with your specific login details, URL, selectors,
#    and desired fingerprint spoofing settings.
# 4. Execute the script: python your_script_name.py

if __name__ == "__main__":
    # Example: Load a pre-configured script
    # Ensure 'config.json' exists or the default will be used.
    login_bot = AdvancedAutomatedLoginScript("config.json")
    login_bot.run()

    # Example: Dynamically update a configuration value (e.g., if a UI provided it)
    # login_bot.update_config("login_url", "https://new-login-page.com")
    # login_bot.run() # Run again with updated config