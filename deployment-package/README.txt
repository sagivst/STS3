═══════════════════════════════════════════════════════════
  STS3 Deployment Package - Installation Instructions
═══════════════════════════════════════════════════════════

📦 This package contains:
  • frontend-dist/     - Built frontend (React + Vite)
  • backend-app/       - Backend Python code (FastAPI)
  • INSTALL.sh         - Automatic installation script
  • README.txt         - This file

═══════════════════════════════════════════════════════════
  OPTION 1: Automatic Installation (Recommended)
═══════════════════════════════════════════════════════════

1. Upload this entire folder to your Azure VM:

   scp -r deployment-package azureuser@YOUR-VM-ADDRESS:~/

2. SSH to your VM:

   ssh azureuser@YOUR-VM-ADDRESS

3. Run the installation script:

   cd deployment-package
   sudo bash INSTALL.sh

That's it! The script will:
  ✓ Update frontend files
  ✓ Update backend code
  ✓ Set correct permissions
  ✓ Restart all services
  ✓ Show you the status

═══════════════════════════════════════════════════════════
  OPTION 2: Manual Installation
═══════════════════════════════════════════════════════════

1. Update Frontend:
   sudo rm -rf /var/www/sts3/*
   sudo cp -r frontend-dist/* /var/www/sts3/
   sudo chown -R www-data:www-data /var/www/sts3

2. Update Backend:
   sudo rm -rf /opt/sts3-backend/app
   sudo cp -r backend-app /opt/sts3-backend/app
   sudo chown -R azureuser:azureuser /opt/sts3-backend

3. Restart Services:
   sudo systemctl restart sts3-backend
   sudo systemctl restart nginx

═══════════════════════════════════════════════════════════
  Need Help?
═══════════════════════════════════════════════════════════

Check the logs first, they usually show what's wrong!

Good luck! 🚀
